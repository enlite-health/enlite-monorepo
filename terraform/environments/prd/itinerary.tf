# ---------------------------------------------------------------------------
# Itinerário (spec 069): rotina diária de cobertura + alarme de rotina ausente
# ---------------------------------------------------------------------------
# NÃO APLICADO — apply é GATE do Gabriel, depois do deploy da main (a rota
# POST /api/internal/itinerary/daily precisa existir antes do primeiro disparo).
#
# Molde: enquadre.tf (Scheduler com X-Internal-Secret de internal-token-secret) e
# events.tf (métrica de log + alert policy de ESTADO).
# Fuso: os moldes usam Etc/UTC; aqui usamos America/Argentina/Buenos_Aires porque o
# Scheduler aceita o fuso nomeado e o requisito é "06:00 de Buenos Aires" (AR não tem
# horário de verão; o resultado equivale a 09:00 UTC, mas o intent fica explícito).

resource "google_cloud_scheduler_job" "itinerary_daily" {
  project          = var.project_id
  region           = var.scheduler_region
  name             = "itinerary-daily"
  description      = "Spec 069: rotina diária do itinerário (cobertura/substituições). Idempotente."
  schedule         = "0 6 * * *"
  time_zone        = "America/Argentina/Buenos_Aires"
  attempt_deadline = "300s"

  # Retry curto: a rota é idempotente e o Scheduler é "at least once" (500 -> retry).
  retry_config {
    retry_count          = 2
    max_backoff_duration = "3600s"
    max_doublings        = 5
    max_retry_duration   = "0s"
    min_backoff_duration = "5s"
  }

  http_target {
    http_method = "POST"
    uri         = "${var.events_api_base_url}/api/internal/itinerary/daily"
    headers = {
      "X-Internal-Secret" = data.google_secret_manager_secret_version.internal_token.secret_data
    }
  }
}

# Emitida pelo health check (GET /api/internal/events/health, a cada 5 min) a CADA ciclo
# em que a rotina diária do dia não tenha rodado (WARN, campos country e operationDate).
# Sinal de ESTADO: não auto-resolve com o job parado/não aplicado.
resource "google_logging_metric" "itinerary_daily_run_missing" {
  project     = var.project_id
  name        = "itinerary_daily_run_missing"
  description = "A rotina diária do itinerário não rodou no dia operacional. Sinal de ESTADO reemitido a cada ciclo do health check."
  filter      = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"worker-functions\" AND jsonPayload.msg=\"itinerary_daily_run_missing\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_monitoring_alert_policy" "itinerary_daily_run_missing" {
  project      = var.project_id
  display_name = "[ATENÇÃO] Rotina diária do itinerário não rodou (job itinerary-daily)"
  combiner     = "OR"
  enabled      = true
  severity     = "WARNING"

  notification_channels = [var.events_notification_channel]

  documentation {
    mime_type = "text/markdown"
    subject   = "Rotina diária do itinerário não rodou: alertas de turnos sem cobertura não estão saindo"
    content   = <<-EOT
      ## Impacto
      A rotina `POST /api/internal/itinerary/daily` não registrou execução para o dia operacional
      (campos `country` e `operationDate` no log). Turnos descobertos não geram o aviso aos gestores.

      ## O que este alerta afirma
      O health check (`GET /api/internal/events/health`, a cada 5 min) reemite o WARN
      `itinerary_daily_run_missing` enquanto não houver registro da rotina do dia. Sinal de **ESTADO**.

      ## Modos de falha (em ordem de probabilidade)
      1. **Job não aplicado / pausado** — `gcloud scheduler jobs describe itinerary-daily --location=southamerica-east1`.
      2. **Rota respondendo 500** — ver os logs do `worker-functions` na hora do disparo (06:00 Buenos Aires).
      3. **Segredo interno divergente** — 401/403 na chamada do Scheduler.

      ## Correção
      Aplicar/despausar o job e disparar uma vez à mão (idempotente):
      `curl -X POST -H "X-Internal-Secret: $SEGREDO" "$BASE/api/internal/itinerary/daily"`.
    EOT
  }

  # 7 dias: não fecha por decurso de prazo enquanto o heartbeat renovar.
  alert_strategy {
    auto_close = "604800s"
  }

  conditions {
    display_name = "rotina diária do itinerário ausente no dia operacional"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/itinerary_daily_run_missing\" AND resource.type=\"cloud_run_revision\""
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

  depends_on = [google_logging_metric.itinerary_daily_run_missing]
}
