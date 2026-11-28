# G2 (D825): o teto global diário de OTP bateu → e-mail do Gabriel (var.events_notification_channel, events.tf:35-38).
resource "google_logging_metric" "otp_global_ceiling_reached" {
  project = var.project_id
  name    = "otp_global_ceiling_reached"
  filter  = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"worker-functions\" AND jsonPayload.msg=\"otp_global_ceiling_reached\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}

resource "google_monitoring_alert_policy" "otp_global_ceiling_reached" {
  project               = var.project_id
  display_name          = "[ATENCAO] OTP: teto global diario atingido (OTP_GLOBAL_DAILY_MAX)"
  combiner              = "OR"
  enabled               = true
  severity              = "WARNING"
  notification_channels = [var.events_notification_channel]
  documentation {
    mime_type = "text/markdown"
    subject   = "OTP: teto global diario atingido"
    content   = "O worker-functions recusou envio de OTP porque o total do dia (Buenos Aires) chegou a OTP_GLOBAL_DAILY_MAX. Ate a meia-noite de Buenos Aires, claim/start e phone-verification/start respondem 503. Conferir em Cloud Logging jsonPayload.msg=\"otp_global_ceiling_reached\" (campos sent e dailyMax) e o volume no console da Twilio. Subir o teto = mudar a env no backend-prd.yml (D825)."
  }
  alert_strategy {
    auto_close = "86400s"
  }
  conditions {
    display_name = "otp_global_ceiling_reached > 0 em 5 min"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/otp_global_ceiling_reached\" AND resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      trigger {
        count = 1
      }
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }
  depends_on = [google_logging_metric.otp_global_ceiling_reached]
}
