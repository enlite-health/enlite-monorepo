# Spec 077 F5 (FR-56/57): retencao de 90 dias das coordenadas do attendance em prd.
# Job diario attendance-retention (Cloud Run Job, mesma imagem do attendance-service) chama
# attendance.purge_old_coordinates(interval '90 days') pelo script dist/scripts/retention.js (PR-ATT-07) e loga 1 linha
# JSON {"event":"attendance_retention","purged":N,"pending_over_90d":M,"deletion_requests_stale":K}.
# Banco: connector do Cloud SQL com login IAM por IP publico (pg-pool.factory.ts do attendance), sem socket /cloudsql.
# Imagem: a do attendance-service NO MOMENTO da criacao (data source); depois o HCL ignora a imagem (FR-56; padrao de
# terraform/modules/cloud-run/main.tf, ignore_changes da imagem): quem a renova e o workflow do attendance.

data "google_cloud_run_v2_service" "attendance" {
  project  = var.project_id
  location = "southamerica-west1"
  name     = "attendance-service"
}

resource "google_cloud_run_v2_job" "attendance_retention" {
  project  = var.project_id
  name     = "attendance-retention"
  location = "southamerica-west1"

  template {
    task_count  = 1
    parallelism = 1

    template {
      service_account = module.sa_attendance_retention.email
      max_retries     = 1
      timeout         = "600s"

      containers {
        image   = data.google_cloud_run_v2_service.attendance.template[0].containers[0].image
        command = ["node"]
        args    = ["dist/scripts/retention.js"]

        env {
          name  = "NODE_ENV"
          value = "production"
        }
        env {
          name  = "INSTANCE_CONNECTION_NAME"
          value = module.sql_enlite_ar_db.connection_name
        }
        env {
          name  = "DB_NAME"
          value = "enlite_ar"
        }
        env {
          name  = "DB_USER"
          value = google_sql_user.attendance_retention_iam.name
        }
        env {
          name  = "DELETION_STALE_HOURS"
          value = "72"
        }

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].template[0].containers[0].image,
      client,
      client_version,
    ]
  }
}

# Disparo diario 03:00 de Buenos Aires (FR-56). Molde: o e2e-prod-smoke-daily vivo (POST no jobs/<job>:run da API v2 com
# oauth_token). Quem chama e a propria SA do job, que so tem run.invoker NESTE job (run.invoker inclui run.jobs.run).
resource "google_cloud_run_v2_job_iam_member" "attendance_retention_invoker" {
  project  = var.project_id
  location = google_cloud_run_v2_job.attendance_retention.location
  name     = google_cloud_run_v2_job.attendance_retention.name
  role     = "roles/run.invoker"
  member   = module.sa_attendance_retention.member
}

resource "google_cloud_scheduler_job" "attendance_retention" {
  project          = var.project_id
  region           = var.scheduler_region
  name             = "attendance-retention"
  description      = "Spec 077 F5: retencao de 90 dias das coordenadas do attendance (Cloud Run Job attendance-retention). Idempotente."
  schedule         = "0 3 * * *"
  time_zone        = "America/Argentina/Buenos_Aires"
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
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${google_cloud_run_v2_job.attendance_retention.location}/jobs/${google_cloud_run_v2_job.attendance_retention.name}:run"

    oauth_token {
      service_account_email = module.sa_attendance_retention.email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }

  depends_on = [google_cloud_run_v2_job_iam_member.attendance_retention_invoker]
}

# Alarme (FR-57). Canal: o de alertas de prd do admission.tf (D669, DP-06): var.events_notification_channel.
# Sinal de vida: toda execucao loga event=attendance_retention. Pendentes: so as linhas com pending_over_90d > 0
# (linhas com received_at < now() - 90 dias e coords_purged_at IS NULL DEPOIS da purga; nunca "purgados > 0").
resource "google_logging_metric" "attendance_retention_run" {
  project     = var.project_id
  name        = "attendance_retention_run"
  description = "Retencao do attendance (spec 077 F5): sinal de vida do job diario attendance-retention"
  filter      = "resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"attendance-retention\" AND jsonPayload.event=\"attendance_retention\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_logging_metric" "attendance_retention_pending" {
  project     = var.project_id
  name        = "attendance_retention_pending"
  description = "Retencao do attendance (spec 077 F5): execucao que terminou com coordenada de mais de 90 dias ainda gravada"
  filter      = "resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"attendance-retention\" AND jsonPayload.event=\"attendance_retention\" AND jsonPayload.pending_over_90d > 0"

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_monitoring_alert_policy" "attendance_retention" {
  project      = var.project_id
  display_name = "[URGENTE] Retencao 90 dias do attendance: job parado ou coordenada vencida gravada (attendance_retention)"
  combiner     = "OR"
  enabled      = true
  severity     = "ERROR"

  notification_channels = [var.events_notification_channel]

  documentation {
    mime_type = "text/markdown"
    subject   = "Retencao de 90 dias do attendance falhou"
    content   = "Ou o job attendance-retention nao logou event=attendance_retention em ~23 h 30 min (job parado, Scheduler PAUSED, imagem sem dist/scripts/retention.js, banco recusando), ou uma execucao terminou com pending_over_90d > 0 (coordenada com mais de 90 dias ainda gravada). Conferir: `gcloud scheduler jobs describe attendance-retention --location=southamerica-east1 --project=enlite-prd`, `gcloud run jobs executions list --job=attendance-retention --region=southamerica-west1 --project=enlite-prd` e os logs do job. Reexecutar e idempotente: `gcloud run jobs execute attendance-retention --region=southamerica-west1 --project=enlite-prd --wait`."
  }

  alert_strategy {
    auto_close = "86400s"
  }

  # Dois limites: a API recusa duration > 23h30m (84600s) e a doc limita alinhamento + duracao de ausencia a 25 h
  # (5400s + 84600s = 90000s). Job diario nao da falso alarme (buraco entre pontos alinhados ~22h30 < 23h30); dia perdido ~46h30.
  conditions {
    display_name = "sem event=attendance_retention ha 23 h 30 min"
    condition_absent {
      filter   = "metric.type=\"logging.googleapis.com/user/attendance_retention_run\" AND resource.type=\"cloud_run_job\""
      duration = "84600s"

      aggregations {
        alignment_period     = "5400s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }

  conditions {
    display_name = "execucao com pending_over_90d > 0"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/attendance_retention_pending\" AND resource.type=\"cloud_run_job\""
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

  depends_on = [google_logging_metric.attendance_retention_run, google_logging_metric.attendance_retention_pending]
}

# A-20 (D663) e DP-07 (D669): pedido de exclusao de conta parado ha mais de 72 h (DELETION_STALE_HOURS do job).
# A operacao le a fila pelo MCP somente-leitura (enlite_mcp_ro); este alarme so avisa que ela esta parada.
resource "google_logging_metric" "attendance_deletion_requests_stale" {
  project     = var.project_id
  name        = "attendance_deletion_requests_stale"
  description = "Attendance (spec 077 A-20): execucao do job diario que contou pedido de exclusao REQUESTED ha mais de 72 h"
  filter      = "resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"attendance-retention\" AND jsonPayload.event=\"attendance_retention\" AND jsonPayload.deletion_requests_stale > 0"

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_monitoring_alert_policy" "attendance_deletion_requests_stale" {
  project      = var.project_id
  display_name = "[ATENCAO] Pedido de exclusao de conta parado ha mais de 72 h (attendance_retention)"
  combiner     = "OR"
  enabled      = true
  severity     = "WARNING"

  notification_channels = [var.events_notification_channel]

  documentation {
    mime_type = "text/markdown"
    subject   = "Fila de exclusao de conta parada"
    content   = "O job attendance-retention contou deletion_requests_stale > 0: ha pedido em attendance.account_deletion_request com status REQUESTED e requested_at ha mais de 72 h. A fila e da operacao (leitura pelo MCP somente-leitura enlite_mcp_ro). O alerta repete a cada execucao diaria enquanto a fila estiver parada."
  }

  alert_strategy {
    auto_close = "86400s"
  }

  conditions {
    display_name = "execucao com deletion_requests_stale > 0"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/attendance_deletion_requests_stale\" AND resource.type=\"cloud_run_job\""
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

  depends_on = [google_logging_metric.attendance_deletion_requests_stale]
}
