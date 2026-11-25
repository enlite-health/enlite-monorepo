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
