# ---------------------------------------------------------------------------
# Axonico: falha no lançamento de prestação (PUT /api/comprobante)
# ---------------------------------------------------------------------------
# Entre 26/10 e 29/10/2026 o Axonico recusou 6 lançamentos (HTTP 400 "FECHA DE
# PRESTACION INCORRECTA") e ninguém viu até a operadora mandar print: não havia
# métrica nem alerta do Axonico. Molde: `anacare_mirror_stuck` (events.tf).
#
# Diferente do espelho Ana Care (sinal de ESTADO), aqui cada linha de log é uma
# recusa pontual do terceiro: métrica de borda (DELTA), alerta dispara com > 0.
#
# Mensagens (AxonicoApiClient.ts, TAG `[AxonicoApiClient]`), todas com `method`+`path`:
#   - erro do terceiro — HTTP não-2xx (negócio/servidor)   [400/403/412/500]
#   - erro do terceiro — HTTP 422 (validação)
#   - 401 numa escrita — estado INDETERMINADO, não repetida automaticamente
# Falha de rede sem resposta HTTP não entra de propósito (sem `status` do terceiro).
resource "google_logging_metric" "axonico_comprobante_put_failure" {
  project     = var.project_id
  name        = "axonico_comprobante_put_failure"
  description = "Falha do PUT /api/comprobante no Axonico (lançamento de prestação recusado ou em estado indeterminado). Uma linha de log por falha."
  filter      = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"worker-functions\" AND jsonPayload.path=\"/api/comprobante\" AND jsonPayload.method=\"PUT\" AND (jsonPayload.msg=\"[AxonicoApiClient] erro do terceiro — HTTP não-2xx (negócio/servidor)\" OR jsonPayload.msg=\"[AxonicoApiClient] erro do terceiro — HTTP 422 (validação)\" OR jsonPayload.msg=\"[AxonicoApiClient] 401 numa escrita — estado INDETERMINADO, não repetida automaticamente\")"

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"

    labels {
      key         = "status"
      value_type  = "STRING"
      description = "HTTP status devolvido pelo Axonico (ausente no 401 indeterminado)"
    }
  }

  label_extractors = {
    "status" = "EXTRACT(jsonPayload.status)"
  }
}

resource "google_monitoring_alert_policy" "axonico_comprobante_put_failure" {
  project      = var.project_id
  display_name = "[URGENTE] Axonico recusou lançamento de prestação (PUT /api/comprobante)"
  combiner     = "OR"
  enabled      = true
  severity     = "ERROR"

  notification_channels = [var.events_notification_channel]

  documentation {
    mime_type = "text/markdown"
    subject   = "Axonico recusou um lançamento de prestação (PUT /api/comprobante)"
    content   = <<-EOT
      ## O que significa
      O Axonico recusou (ou deixou em estado indeterminado) um `PUT /api/comprobante` do
      worker-functions. O lançamento da prestação **não foi faturado** e ninguém vê pela tela.

      ## Onde olhar
      Logs do Cloud Run `worker-functions`, filtro:
      `jsonPayload.path="/api/comprobante" AND jsonPayload.method="PUT" AND jsonPayload.msg=~"AxonicoApiClient\] (erro do terceiro|401 numa escrita)"`

      Campos úteis: `status`, `axonicoMessage` (motivo dado pelo Axonico) e `axonicoBody`
      (corpo cru, truncado e redigido).

      ## Causa já conhecida
      `400 FECHA DE PRESTACION INCORRECTA` = hora do fecho no fuso errado (corrigido no PR #770).
      Se voltar com outro motivo, é causa nova.

      ## Atenção
      `PUT /api/comprobante` **FATURA** no Axonico: nunca reproduzir em teste nem repetir à mão
      para "ver se passa".
    EOT
  }

  # Mesmo critério do espelho Ana Care: não fechar em silêncio por decurso de prazo.
  alert_strategy {
    auto_close = "604800s"
  }

  conditions {
    display_name = "PUT /api/comprobante falhou no Axonico"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/axonico_comprobante_put_failure\" AND resource.type=\"cloud_run_revision\""
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

  depends_on = [google_logging_metric.axonico_comprobante_put_failure]
}
