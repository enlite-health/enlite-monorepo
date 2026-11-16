# spec 077 D723 (15/11/2026): o Cloud SQL de prd (enlite-ar-db, db-custom-1-3840) tem max_connections=100 (~94 uteis; medido em 16/11: pico de 30 dias = 29).
# Alerta quando a SOMA das conexoes (num_backends, todas as bases da instancia) passar de 70, antes de o banco recusar conexao. Canal: o de alertas de
# prd do admission.tf (var.events_notification_channel).
resource "google_monitoring_alert_policy" "cloudsql_connections_high" {
  project      = var.project_id
  display_name = "[ATENCAO] Cloud SQL enlite-ar-db: mais de 70 conexoes (max_connections=100)"
  combiner     = "OR"
  enabled      = true
  severity     = "WARNING"

  notification_channels = [var.events_notification_channel]

  documentation {
    mime_type = "text/markdown"
    subject   = "enlite-ar-db com mais de 70 conexoes"
    content   = "A soma de num_backends da instancia enlite-ar-db passou de 70 (max_connections=100, ~94 uteis). Quem abre conexao: worker-functions (DB_POOL_MAX + DB_SYSTEM_POOL_MAX por instancia), worker-functions-mcp, attendance-service (DB_POOL_MAX) e o job attendance-retention. Conferir max-instances e DB_POOL_MAX dos 3 servicos com gcloud run services describe; nao aumentar max_connections nem o tier sem decisao (D723)."
  }

  alert_strategy {
    auto_close = "86400s"
  }

  conditions {
    display_name = "num_backends > 70 por 1 min"
    condition_threshold {
      filter          = "metric.type=\"cloudsql.googleapis.com/database/postgresql/num_backends\" AND resource.type=\"cloudsql_database\" AND resource.labels.database_id=\"${var.project_id}:enlite-ar-db\""
      comparison      = "COMPARISON_GT"
      threshold_value = 70
      duration        = "60s"

      trigger {
        count = 1
      }

      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_MAX"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }
}
