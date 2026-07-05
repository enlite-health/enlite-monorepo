# =============================================================================
# Outbox / Domain-events infra (enlite-prd)
# =============================================================================
# Estes recursos foram criados MANUALMENTE via gcloud durante o incidente do
# sync AnaCare (jul/2026) e estão sendo adotados pelo Terraform sem recriação.
# Import: ver terraform/environments/prd/IMPORT_EVENTS.md
#
# Fluxo: worker-functions grava em domain_events (outbox) -> publica em tópicos
# Pub/Sub -> subscriptions push chamam /api/internal/events/process. Schedulers
# batem em /health (a cada 5min) e /sweep-safe (a cada 10min). Log-based metrics
# + alert policies são a tripwire que faltava quando o AnaCare quebrou 5 dias.
# =============================================================================

# ---------------------------------------------------------------------------
# Variáveis específicas de eventos (defaults refletem o estado atual de prd)
# ---------------------------------------------------------------------------
variable "events_api_base_url" {
  type        = string
  description = "Base URL pública do worker-functions (schedulers e push endpoint)"
  default     = "https://api.enlite.health"
}

variable "worker_functions_run_url" {
  type        = string
  description = "URL canônica do Cloud Run worker-functions, usada como audience do OIDC token das subscriptions push"
  default     = "https://worker-functions-121472682203.southamerica-west1.run.app"
}

variable "scheduler_region" {
  type        = string
  description = "Região dos Cloud Scheduler jobs (App Engine region do projeto)"
  default     = "southamerica-east1"
}

variable "events_notification_channel" {
  type        = string
  description = "Resource name do notification channel para os alertas de domain_event"
  default     = "projects/enlite-prd/notificationChannels/8185909418742864008"
}

# ---------------------------------------------------------------------------
# Secret: X-Internal-Secret dos schedulers
# ---------------------------------------------------------------------------
# DECISÃO: o valor do header X-Internal-Secret que estava inline nos schedulers
# (ZzOe...4a0=) é BYTE-A-BYTE igual ao secret já existente `internal-token-secret`
# (o mesmo usado em /api/internal/vertex-health — ver secrets.tf). Portanto NÃO
# criamos secret novo: lemos o existente via data source. Assim o valor nunca
# aparece hardcoded no HCL nem no state em texto (secret_data é sensitive).
data "google_secret_manager_secret_version" "internal_token" {
  project = var.project_id
  secret  = "internal-token-secret"
}

# ---------------------------------------------------------------------------
# Pub/Sub topics
# ---------------------------------------------------------------------------
resource "google_pubsub_topic" "worker_mirror_requested" {
  project = var.project_id
  name    = "worker-mirror-requested"
}

resource "google_pubsub_topic" "worker_registration_completed" {
  project = var.project_id
  name    = "worker-registration-completed"
}

# ---------------------------------------------------------------------------
# Pub/Sub push subscriptions -> /api/internal/events/process (OIDC)
# ---------------------------------------------------------------------------
locals {
  events_push_endpoint = "${var.events_api_base_url}/api/internal/events/process"
}

resource "google_pubsub_subscription" "worker_mirror_requested_push" {
  project = var.project_id
  name    = "worker-mirror-requested-push"
  topic   = google_pubsub_topic.worker_mirror_requested.id

  ack_deadline_seconds       = 30
  message_retention_duration = "604800s"

  expiration_policy {
    ttl = "2678400s"
  }

  push_config {
    push_endpoint = local.events_push_endpoint
    oidc_token {
      service_account_email = module.sa_pubsub_invoker.email
      audience              = var.worker_functions_run_url
    }
  }
}

resource "google_pubsub_subscription" "worker_registration_completed_push" {
  project = var.project_id
  name    = "worker-registration-completed-push"
  topic   = google_pubsub_topic.worker_registration_completed.id

  ack_deadline_seconds       = 30
  message_retention_duration = "604800s"

  expiration_policy {
    ttl = "2678400s"
  }

  push_config {
    push_endpoint = local.events_push_endpoint
    oidc_token {
      service_account_email = module.sa_pubsub_invoker.email
      audience              = var.worker_functions_run_url
    }
  }
}

# ---------------------------------------------------------------------------
# Cloud Scheduler jobs (região southamerica-east1)
# ---------------------------------------------------------------------------
# NOTA: o header "User-Agent: Google-Cloud-Scheduler" é injetado pelo próprio
# serviço e NÃO é declarado aqui (o provider o ignora no diff).
resource "google_cloud_scheduler_job" "events_health" {
  project          = var.project_id
  region           = var.scheduler_region
  name             = "events-health"
  schedule         = "*/5 * * * *"
  time_zone        = "Etc/UTC"
  attempt_deadline = "180s"

  retry_config {
    retry_count          = 0
    max_backoff_duration = "3600s"
    max_doublings        = 5
    max_retry_duration   = "0s"
    min_backoff_duration = "5s"
  }

  http_target {
    http_method = "GET"
    uri         = "${var.events_api_base_url}/api/internal/events/health"
    headers = {
      "X-Internal-Secret" = data.google_secret_manager_secret_version.internal_token.secret_data
    }
  }
}

resource "google_cloud_scheduler_job" "events_sweep_safe" {
  project          = var.project_id
  region           = var.scheduler_region
  name             = "events-sweep-safe"
  schedule         = "*/10 * * * *"
  time_zone        = "Etc/UTC"
  attempt_deadline = "180s"

  retry_config {
    retry_count          = 0
    max_backoff_duration = "3600s"
    max_doublings        = 5
    max_retry_duration   = "0s"
    min_backoff_duration = "5s"
  }

  http_target {
    http_method = "POST"
    uri         = "${var.events_api_base_url}/api/internal/events/sweep-safe"
    body        = base64encode("{}")
    headers = {
      "Content-Type"      = "application/json"
      "X-Internal-Secret" = data.google_secret_manager_secret_version.internal_token.secret_data
    }
  }
}

# ---------------------------------------------------------------------------
# Log-based metrics
# ---------------------------------------------------------------------------
resource "google_logging_metric" "domain_event_delivery_failure" {
  project     = var.project_id
  name        = "domain_event_delivery_failure"
  description = "Outbox/domain_event delivery falhou silenciosamente (publish Pub/Sub falhou OU sem handler). Tripwire do buraco AnaCare 2026-07."
  filter      = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"worker-functions\" AND (jsonPayload.msg:\"Pub/Sub publish failed\" OR jsonPayload.msg:\"No handler registered for event\")"

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_logging_metric" "domain_event_backlog_stuck" {
  project = var.project_id
  name    = "domain_event_backlog_stuck"
  # Exclui funnel_stage.rejected / not_qualified: eventos do Talentum sem consumidor
  # (Kanban já reflete a rejeição via UPDATE síncrono em worker_job_applications,
  # migration 191) — são órfãos por design, não devem paginar. Ver docs/FOLLOWUPS.md.
  filter = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"worker-functions\" AND jsonPayload.msg=\"[events/health] backlog stuck\" AND NOT (jsonPayload.event=\"funnel_stage.rejected\" OR jsonPayload.event=\"funnel_stage.not_qualified\")"

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"

    labels {
      key         = "event"
      value_type  = "STRING"
      description = "domain_events.event name"
    }
  }

  label_extractors = {
    "event" = "EXTRACT(jsonPayload.event)"
  }
}

# ---------------------------------------------------------------------------
# Alert policies (notification channel existente via var)
# ---------------------------------------------------------------------------
resource "google_monitoring_alert_policy" "domain_event_delivery_failure" {
  project      = var.project_id
  display_name = "[URGENTE] Domain event delivery falhou (outbox/AnaCare)"
  combiner     = "OR"
  enabled      = true

  notification_channels = [var.events_notification_channel]

  documentation {
    mime_type = "text/markdown"
    content   = "Um domain_event NÃO foi entregue: publish no Pub/Sub falhou (ex: topic inexistente) OU nenhum handler registrado. Foi ASSIM que o sync AnaCare ficou 5 dias quebrado em silencio (jul/2026). Checar: (1) topic+sub do evento existem em prod? (2) handler registrado em src/index.ts? (3) backlog em domain_events WHERE status='pending'."
  }

  alert_strategy {
    auto_close = "1800s"
  }

  conditions {
    display_name = "delivery failures > 0 em 5min"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/domain_event_delivery_failure\" AND resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"

      trigger {
        count = 1
      }

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }

  depends_on = [google_logging_metric.domain_event_delivery_failure]
}

resource "google_monitoring_alert_policy" "domain_event_backlog_stuck" {
  project      = var.project_id
  display_name = "[URGENTE] Backlog de domain_event travado (por tipo)"
  combiner     = "OR"
  enabled      = true

  notification_channels = [var.events_notification_channel]

  documentation {
    mime_type = "text/markdown"
    content   = "Um tipo de domain_event tem backlog RECENTE parado além do limite (não processado a tempo). O label 'event' diz EXATAMENTE qual pipeline travou (ex: worker.mirror_requested = sync AnaCare). Diagnóstico: GET /api/internal/events/health mostra pending/failed/idade por tipo. Foi assim que o AnaCare ficou 5 dias quebrado sem ninguém ver."
  }

  alert_strategy {
    auto_close = "1800s"
  }

  conditions {
    display_name = "backlog recente travado > 0 (por tipo de evento)"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/domain_event_backlog_stuck\" AND resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"

      trigger {
        count = 1
      }

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["metric.label.event"]
      }
    }
  }

  depends_on = [google_logging_metric.domain_event_backlog_stuck]
}
