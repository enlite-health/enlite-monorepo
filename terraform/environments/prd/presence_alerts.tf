# ---------------------------------------------------------------------------
# Presença sem furo (spec 077, emenda D806/D812, F6): alerta à coordenação a cada 15 min
# ---------------------------------------------------------------------------
# NÃO APLICADO — apply é GATE do Gabriel, depois do deploy da main (a rota
# POST /api/internal/presence/alerts precisa existir antes do primeiro disparo).
#
# O job NASCE PAUSADO (`paused = true`): ligar é ato do Gabriel (parada legítima da emenda). Para ligar,
# trocar para `paused = false` neste arquivo e aplicar (nunca `gcloud scheduler jobs resume`: o HCL é a autoridade).
# Molde: itinerary.tf (Scheduler com X-Internal-Secret de internal-token-secret + métrica de log + alert policy).

resource "google_cloud_scheduler_job" "presence_alerts" {
  project          = var.project_id
  region           = var.scheduler_region
  name             = "presence-alerts"
  description      = "Spec 077 D806/D812: alerta de presença à coordenação (turno aberto > 4 h; check-in recusado sem entrada). Idempotente (UNIQUE kind+occurrence_id)."
  schedule         = "*/15 * * * *"
  time_zone        = "Etc/UTC"
  attempt_deadline = "300s"
  paused           = true

  # Retry curto: a rota é idempotente e o Scheduler é "at least once" (500 -> retry; attendance fora do ar = 500).
  retry_config {
    retry_count          = 2
    max_backoff_duration = "300s"
    max_doublings        = 3
    max_retry_duration   = "0s"
    min_backoff_duration = "5s"
  }

  http_target {
    http_method = "POST"
    uri         = "${var.events_api_base_url}/api/internal/presence/alerts"
    headers = {
      "X-Internal-Secret" = data.google_secret_manager_secret_version.internal_token.secret_data
    }
  }
}

# O controller loga `[presence/alerts] done` (INFO, só contagens, sem PII) a CADA execução que termina com 200.
resource "google_logging_metric" "presence_alerts_run" {
  project     = var.project_id
  name        = "presence_alerts_run"
  description = "Execuções concluídas (HTTP 200) da rota POST /api/internal/presence/alerts (job presence-alerts, a cada 15 min)."
  filter      = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"worker-functions\" AND jsonPayload.msg=\"[presence/alerts] done\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

# Alarme de NÃO-EXECUÇÃO: nenhuma execução concluída por 45 min (3 ciclos de 15 min).
# COM O JOB PAUSADO ELE DISPARARIA (ausência é exatamente o que o job pausado produz), por isso nasce `enabled = false`.
# Ao ligar o job (paused = false), ligar a política NO MESMO apply (enabled = true).
resource "google_monitoring_alert_policy" "presence_alerts_run_missing" {
  project      = var.project_id
  display_name = "[ATENÇÃO] Alerta de presença à coordenação não executou (job presence-alerts)"
  combiner     = "OR"
  enabled      = false
  severity     = "WARNING"

  notification_channels = [var.events_notification_channel]

  documentation {
    mime_type = "text/markdown"
    subject   = "Alerta de presença não executou há 45 min: turno aberto > 4 h e check-in recusado podem não estar chegando à coordenação"
    content   = <<-EOT
      ## Impacto
      A rotina `POST /api/internal/presence/alerts` não concluiu nenhuma execução (log `[presence/alerts] done`) por 45 minutos.
      Sem ela, a coordenação não é avisada de saída não declarada nem de check-in recusado sem entrada.

      ## Modos de falha (em ordem de probabilidade)
      1. **Job pausado / não aplicado** — `gcloud scheduler jobs describe presence-alerts --location=southamerica-east1`.
      2. **Rota respondendo 500** — attendance fora do ar (a rota devolve 500 para o Scheduler re-tentar) ou erro do worker-functions.
      3. **Segredo interno divergente** — 401/403 na chamada do Scheduler.

      ## Correção
      Despausar pelo HCL (`paused = false`) ou disparar uma vez à mão (idempotente):
      `curl -X POST -H "X-Internal-Secret: $SEGREDO" "$BASE/api/internal/presence/alerts"`.
    EOT
  }

  alert_strategy {
    auto_close = "604800s"
  }

  conditions {
    display_name = "nenhuma execução do alerta de presença em 45 min"
    condition_absent {
      filter   = "metric.type=\"logging.googleapis.com/user/presence_alerts_run\" AND resource.type=\"cloud_run_revision\""
      duration = "2700s"

      trigger {
        count = 1
      }

      aggregations {
        alignment_period     = "900s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }

  depends_on = [google_logging_metric.presence_alerts_run]
}

# A rota de serviço do attendance (OIDC do Google verificado pelo próprio attendance) exige run.invoker do SA do WF.
# Conferido em 26/11/2026 (get-iam-policy): só mobile-bff-sa e mobile-bff-ks-sa tinham o papel; o do WF NÃO existia à mão,
# logo é CRIADO aqui (sem bloco import). Mesmo padrão de bff_invokes_attendance (attendance_services.tf).
resource "google_cloud_run_v2_service_iam_member" "wf_invokes_attendance" {
  project  = var.project_id
  location = "southamerica-west1"
  name     = "attendance-service"
  role     = "roles/run.invoker"
  member   = module.sa_enlite_functions.member
}
