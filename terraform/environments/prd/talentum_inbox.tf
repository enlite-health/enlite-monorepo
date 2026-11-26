# ---------------------------------------------------------------------------
# Inbox do webhook do Talentum (spec 095): Pub/Sub + alarme
# ---------------------------------------------------------------------------
# NÃO APLICADO — apply é GATE do Gabriel, depois do deploy da main (a rota
# POST /api/internal/talentum/inbox/process precisa existir antes da primeira entrega).
#
# Molde: events.tf (tópico + subscription push com OIDC de `pubsub-invoker`, audience =
# `worker_functions_run_url`, a mesma que o internalAuthMiddleware confere via
# CLOUD_RUN_SERVICE_URL) e itinerary.tf (métrica de log + alert policy).
# O nome do tópico é o de TALENTUM_INBOX_TOPIC no TalentumInboxPublisher (constante, sem env var).
# A mensagem é só `{ inboxId }`: nada de PII trafega pelo Pub/Sub.

resource "google_pubsub_topic" "talentum_inbox" {
  project = var.project_id
  name    = "talentum-inbox"
  labels  = { service = "talentum-inbox", setor = "recrutamento" }
}

resource "google_pubsub_topic" "talentum_inbox_dlq" {
  project = var.project_id
  name    = "talentum-inbox-dlq"
  labels  = { service = "talentum-inbox", setor = "recrutamento" }
}

resource "google_pubsub_subscription" "talentum_inbox_push" {
  project = var.project_id
  name    = "talentum-inbox-push"
  topic   = google_pubsub_topic.talentum_inbox.id

  ack_deadline_seconds       = 60
  message_retention_duration = "604800s"

  expiration_policy {
    ttl = "2678400s"
  }

  push_config {
    push_endpoint = "${var.events_api_base_url}/api/internal/talentum/inbox/process"
    oidc_token {
      service_account_email = module.sa_pubsub_invoker.email
      audience              = var.worker_functions_run_url
    }
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.talentum_inbox_dlq.id
    max_delivery_attempts = 5
  }
}

# O dead-letter exige o agente de serviço do Pub/Sub publicando no DLQ e assinando a subscription de origem.
resource "google_pubsub_topic_iam_member" "talentum_inbox_dlq_publisher" {
  project = var.project_id
  topic   = google_pubsub_topic.talentum_inbox_dlq.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:service-${data.google_project.this.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

resource "google_pubsub_subscription_iam_member" "talentum_inbox_push_subscriber" {
  project      = var.project_id
  subscription = google_pubsub_subscription.talentum_inbox_push.name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:service-${data.google_project.this.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

# ---------------------------------------------------------------------------
# Alarme do webhook do Talentum (T-095-51)
# ---------------------------------------------------------------------------
# Emitida pelo health check (GET /api/internal/events/health, a cada 5 min) a CADA ciclo, 1 WARN por alarme com contagem > 0:
#   { msg: "talentum_webhook_alarm", alarme: <nome>, quantidade: <inteiro> } (sem PII).
# Sinal de ESTADO: não auto-resolve enquanto a condição durar.
resource "google_logging_metric" "talentum_webhook_alarm" {
  project     = var.project_id
  name        = "talentum_webhook_alarm"
  description = "Webhook do Talentum: inbox com falha, pendente, veredito ausente, silêncio ou aviso do sino que falhou. Sinal de ESTADO reemitido a cada ciclo do health check."
  filter      = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"worker-functions\" AND jsonPayload.msg=\"talentum_webhook_alarm\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_monitoring_alert_policy" "talentum_webhook_alarm" {
  project      = var.project_id
  display_name = "[ATENÇÃO] Webhook do Talentum com alarme ativo (inbox, veredito, silêncio ou sino)"
  combiner     = "OR"
  enabled      = true
  severity     = "WARNING"

  notification_channels = [var.events_notification_channel]

  documentation {
    mime_type = "text/markdown"
    subject   = "Webhook do Talentum com alarme ativo: vereditos de candidatos podem não estar chegando ao Kanban"
    content   = <<-EOT
      ## O que este alerta afirma
      O health check (`GET /api/internal/events/health`, a cada 5 min) reemite um WARN `talentum_webhook_alarm` por alarme com contagem > 0
      (campos `alarme` e `quantidade`, sem PII). Sinal de **ESTADO**: dura enquanto a condição durar. Ver o campo `alarme` no log do `worker-functions`:
      - `inbox_falha` — há linhas da inbox em `FAILED`, `REJECTED_SCHEMA` ou `UNSUPPORTED`;
      - `inbox_pendente` — há linha `RECEIVED` parada há mais de 15 min: órfã de publish (o Pub/Sub não entregou ou a assinatura não existe);
      - `veredito_ausente` — espelho `COMPLETED` há mais de 2 h sem veredito;
      - `silencio` — 0 eventos em 6 h dentro da janela 09-21 (Buenos Aires): o Talentum parou de chamar o webhook;
      - `sino_falhou` — o aviso do sino (in-app) falhou;
      - `detector_falhou` — o próprio detector (a leitura de estado do health) falhou: o webhook está sem vigia até a causa sair; ver o ERROR `[talentum-webhook/health] error`.

      ## Primeiros passos
      1. `inbox_pendente`: provar a assinatura VIVA — `gcloud pubsub subscriptions describe talentum-inbox-push` — e olhar o DLQ `talentum-inbox-dlq`.
      2. `inbox_falha`: ler o `status` e o motivo (só enum/código) nos logs do `worker-functions`; corrigir a causa antes do redrive.
      3. `silencio`: conferir com o Talentum se o webhook está ativo e se o ingress do serviço continua aberto.

      ## Redrive (reprocessa linhas da inbox, por chave ou por estado; só contagens na resposta)
      `curl -X POST -H "X-Internal-Secret: $SEGREDO" "$BASE/api/internal/talentum/inbox/redrive"`
    EOT
  }

  # 7 dias: não fecha por decurso de prazo enquanto o heartbeat renovar.
  alert_strategy {
    auto_close = "604800s"
  }

  conditions {
    display_name = "alarme do webhook do Talentum ativo"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/talentum_webhook_alarm\" AND resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"

      trigger {
        count = 1
      }

      aggregations {
        alignment_period     = "1800s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }

  depends_on = [google_logging_metric.talentum_webhook_alarm]
}
