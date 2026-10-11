# ---------------------------------------------------------------------------
# Spec 050 (F12) — alertas do 2º passo da admissão (R-6 e os de F7, F9, F10)
# ---------------------------------------------------------------------------
# ⚠️ NÃO APLICADO: falta o "vai" do Gabriel. Todos NOVOS (só criação). Rollback: `terraform destroy -target` de cada um.
# Custo de API: zero (métrica de log e alerta do Cloud Monitoring não cobram por uso nesta escala).
#
# Alertas de log: entram no MESMO for_each de `admission.tf` (google_logging_metric.admission e
# google_monitoring_alert_policy.admission), via merge — nenhum bloco de recurso é copiado.
# Nomes conferidos 1:1 com o HEAD (worker-functions/src/modules/matching/application):
#   admission.delivery.no_status → AdmissionPostCallJob.ts · admission.calendar_create_failed → admissionCalendarCreate.ts
#   (a compensação da reserva `booked` sem evento sai com reason=booked_without_event, ver admissionCalendarSweeps.ts)
#   admission.cancel.calendar_event_failed e admission.calendar_sweep.failed → admissionCalendarSweeps.ts
# D490 (10/10): todo alarme da admissão vai a TODOS do Acesso Master e se repete até a resolução. O terraform NÃO alcança o grupo:
# o único canal hoje (`events_notification_channel`) é um e-mail pessoal, o grupo vive no banco do app, e política de métrica do
# Cloud Monitoring não renotifica (`notification_rate_limit` só existe em alerta de log-match). Enquanto o ato humano não vier
# (criar o canal do grupo no Cloud Monitoring), vale o canal atual. Quando vier: preencher `admission_alert_channels` com os
# resource names (projects/enlite-prd/notificationChannels/ID) e os alertas da admissão passam a usá-los.
variable "admission_alert_channels" {
  type        = list(string)
  description = "Canais do Cloud Monitoring dos alertas da admissão (D490: grupo Acesso Master). Vazio = usa events_notification_channel."
  default     = []
}

locals {
  # D490 "repetindo até resolver": 1800 s é o MÍNIMO que o Cloud Monitoring aceita (30 min a 24 h), o mais perto de "até resolver".
  admission_alert_renotify_interval = "1800s"
  admission_alert_channels          = length(var.admission_alert_channels) > 0 ? var.admission_alert_channels : [var.events_notification_channel]

  admission_log_alerts_passo2 = {
    delivery_no_status = {
      message  = "admission.delivery.no_status"
      severity = "WARNING"
      what     = "Mensagem da admissão enviada sem status de entrega (Twilio não confirmou): o candidato pode não ter recebido."
    }
    calendar_create_failed = {
      message  = "admission.calendar_create_failed"
      severity = "ERROR"
      what     = "Criação do evento no Google Calendar FALHOU (inclui reserva `booked` sem evento, reason=booked_without_event): a reserva foi liberada ou precisa de ação."
    }
    cancel_calendar_event_failed = {
      message  = "admission.cancel.calendar_event_failed"
      severity = "ERROR"
      what     = "Reunião cancelada cujo evento o Google NÃO apagou: o candidato segue com o convite na agenda."
    }
    calendar_sweep_failed = {
      message  = "admission.calendar_sweep.failed"
      severity = "ERROR"
      what     = "Uma varredura do Google do job de 15 min (apagar evento de cancelada, liberar reserva sem evento) falhou."
    }
  }

  # Sinal de vida (silêncio = job parado). `window` é o tempo sem o log antes de alertar.
  admission_silence_alerts = {
    import_run_done = {
      message = "admission.import.run_done"
      window  = 2700 # roda a cada 15 min (7,22,37,52): 45 min = 3 ciclos perdidos
      what    = "Nenhum `admission.import.run_done` em 45 min: a importação do Tactiq não está rodando (job `admission-import`)."
    }
    tactiq_check_done = {
      message = "admission.tactiq_link.check_done"
      window  = 86400 # roda 1x/dia (12:00 UTC); teto do Cloud Monitoring para condition_absent é 24 h
      what    = "Nenhum `admission.tactiq_link.check_done` em 24 h: o teste diário do vínculo do Tactiq não rodou (job `admission-tactiq-check`)."
    }
  }
}

resource "google_logging_metric" "admission_silence" {
  for_each = local.admission_silence_alerts

  project     = var.project_id
  name        = "admission_${each.key}"
  description = "Admissão (spec 050 F12): sinal de vida ${each.value.message}"
  filter      = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"worker-functions\" AND jsonPayload.message=\"${each.value.message}\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_monitoring_alert_policy" "admission_silence" {
  for_each = local.admission_silence_alerts

  project      = var.project_id
  display_name = "[URGENTE] Admissão: sem ${each.value.message} (job parado)"
  combiner     = "OR"
  enabled      = true
  severity     = "ERROR"

  notification_channels = local.admission_alert_channels

  documentation {
    mime_type = "text/markdown"
    subject   = "Admissão: silêncio de ${each.value.message}"
    content   = "${each.value.what} Conferir `gcloud scheduler jobs list --location=${var.scheduler_region}` (PAUSED?) e os logs do `worker-functions`."
  }

  alert_strategy {
    auto_close = "1800s"
    notification_channel_strategy {
      notification_channel_names = local.admission_alert_channels
      renotify_interval          = local.admission_alert_renotify_interval
    }
  }

  conditions {
    display_name = "sem ${each.value.message} há ${each.value.window} s"
    condition_absent {
      filter   = "metric.type=\"logging.googleapis.com/user/admission_${each.key}\" AND resource.type=\"cloud_run_revision\""
      duration = "${each.value.window}s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }

  depends_on = [google_logging_metric.admission_silence]
}
