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
    # `?limit=20` existe na produção desde antes do import (11/08/2026) e é
    # deliberado: segura o lote por ciclo. Sem ele o schema cai no default de
    # 100, triplicando o trabalho de cada execução do cron. Declarado aqui para
    # o apply não silenciar um ajuste de operação que ninguém pediu para desfazer.
    uri         = "${var.events_api_base_url}/api/internal/events/sweep-safe?limit=20"
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
  # ⚠️ A cláusula `jsonPayload.source="[MirrorWorkerService]:mirrorOne"` é o
  # conserto de 27/07/2026, quando se descobriu que este alerta era CEGO às
  # falhas do espelho Ana Care — o nome citava AnaCare, o filtro não pegava.
  # Ele foi aplicado ao vivo (`gcloud logging metrics update`) e nunca chegou
  # ao HCL. Como o recurso também não estava no state, o desvio ficou invisível
  # até o import de 11/08/2026: o `plan` queria REMOVER a cláusula e cegar o
  # alerta de novo. Mantida aqui para que código e produção digam a mesma coisa.
  filter      = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"worker-functions\" AND (jsonPayload.msg:\"Pub/Sub publish failed\" OR jsonPayload.msg:\"No handler registered for event\" OR jsonPayload.source=\"[MirrorWorkerService]:mirrorOne\")"

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
# Espelho worker -> Ana Care: métrica de ESTADO
# ---------------------------------------------------------------------------
# Emitida pelo health check (GET /api/internal/events/health, cron a cada 5min)
# a CADA ciclo em que existir prestador REGISTERED sem `ana_care_id` além do
# limite. É heartbeat de estado, não contador de borda: a linha de log reaparece
# sozinha enquanto o problema estiver de pé.
#
# Por que a métrica existente não bastava (incidente de 30/07/2026):
#   - `domain_event_delivery_failure` conta linhas de falha em 5min. Passada a
#     rajada zera -> "[RESOLVED] Alert recovered" com o sistema quebrado.
#   - `domain_event_backlog_stuck` decide por `status='pending'`; os 197+ eventos
#     do incidente estavam `status='failed'` (Invalid API key). Cego por
#     construção.
resource "google_logging_metric" "anacare_mirror_stuck" {
  project     = var.project_id
  name        = "anacare_mirror_stuck"
  description = "Existe prestador REGISTERED sem ana_care_id além do limite. Sinal de ESTADO reemitido a cada ciclo do cron enquanto o espelho estiver quebrado."
  filter      = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"worker-functions\" AND jsonPayload.msg=\"[mirror/health] anacare mirror stuck\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
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
  # WARNING (não CRITICAL) de propósito: é sinal de borda e ruidoso. Quem pagina
  # de verdade é a policy de ESTADO `anacare_mirror_stuck`. Sem `severity` o
  # Google gerava assunto "[ALERT - No severity]", que não nomeava nada.
  severity = "WARNING"

  notification_channels = [var.events_notification_channel]

  documentation {
    mime_type = "text/markdown"
    subject   = "Entrega de domain_event falhou (outbox / espelho Ana Care)"
    content   = <<-EOT
      ## O que este alerta é — e o que ele NÃO é
      Alerta de **BORDA**: contou linhas de log de falha nos últimos 5 minutos. Passada a rajada
      a métrica zera e o Monitoring manda `[RESOLVED] Alert recovered` **mesmo com o sistema
      quebrado**. Em 30/07-08/08/2026 isso produziu ~201 pares ALERT/RESOLVED em 11 dias.

      **Não use o RESOLVED deste alerta como prova de que voltou.** Quem responde
      "ainda está quebrado?" é a policy de estado
      `[URGENTE] Espelho Ana Care parado — prestadores REGISTERED sem ana_care_id`.

      ## Modos de falha que caem aqui
      1. **Credencial inválida do Ana Care** — secret `anacare-api-key` (`enlite-prd`) expirado
         ou rotacionado. Sintoma: `HTTP 403 {"detail":"Invalid API key."}` em `MirrorWorkerService:mirrorOne`.
         Foi a causa do incidente de **30/07/2026 16:58 UTC** (197 eventos, 58 prestadores presos).
      2. **Falha de linking** no Ana Care (duplicado / worker não casa). Ver `workers.ana_care_sync_error`.
      3. **Ana Care indisponível** (5xx, timeout).
      4. **Publish no Pub/Sub falhou** (topic inexistente) ou **nenhum handler registrado**
         para o evento — foi o incidente anterior, de jul/2026.

      ## Diagnóstico (nesta ordem)
      1. **`status='failed'` + a coluna `error`** — é onde a causa está escrita:
         `SELECT event, left(error, 120) AS causa, count(*), max(created_at)
          FROM domain_events WHERE status='failed'
            AND created_at > now() - interval '2 days' GROUP BY 1,2 ORDER BY 3 DESC;`
      2. Só depois olhar `status='pending'` (modo 4). No incidente de 30/07 o pending
         esteve **zerado o tempo todo** — quem procurou pending concluiu, errado, que estava tudo bem.
      3. Se for modo 4: topic+subscription existem em prd? Handler registrado em `src/index.ts`?

      ## Correção
      Eventos `failed` **não voltam sozinhos** — o sweep só varre `pending`. Depois de corrigir a
      causa, reprocessar com `BackfillWorkerMirrorUseCase` (dryRun primeiro).
    EOT
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

# ---------------------------------------------------------------------------
# Espelho Ana Care: alerta de ESTADO (o que faltava em 30/07)
# ---------------------------------------------------------------------------
resource "google_monitoring_alert_policy" "anacare_mirror_stuck" {
  project      = var.project_id
  display_name = "[URGENTE] Espelho Ana Care parado — prestadores REGISTERED sem ana_care_id"
  combiner     = "OR"
  enabled      = true
  severity     = "CRITICAL"

  notification_channels = [var.events_notification_channel]

  documentation {
    mime_type = "text/markdown"
    subject   = "Espelho Ana Care parado: prestador cadastrado não chega no Ana Care"
    content   = <<-EOT
      ## Impacto
      Prestador termina o cadastro (`status='REGISTERED'`) e **não aparece no Ana Care**.
      Ele não entra em caso, não é alocado, e ninguém percebe pela tela — o Kanban segue normal.

      ## O que este alerta afirma
      Existe **pelo menos um** worker `REGISTERED` com `ana_care_id IS NULL` que **virou
      REGISTERED** há mais de **2 horas** (default de `mirrorStuckThresholdHours`) e há menos
      de 7 dias.

      O relógio começa na ELEGIBILIDADE (`worker_status_history`), não em `workers.created_at`.
      A linha nasce no signup como `INCOMPLETE_REGISTER` e o espelho só dispara quando o
      cadastro fica completo — usar `created_at` errava nas duas direções e as duas foram
      vistas em 18/08/2026: quem completava o registro dias após o signup nascia "preso há
      148h" (2 páginas falsas no dia, com o espelho são), e quem tinha signup com mais de 7
      dias caía direto em `chronicTotal`, que não pagina — falha nova ficava muda, que é a
      forma do incidente de 30/07.
      É sinal de **ESTADO**: enquanto houver alguém preso, o health check reemite a linha a cada
      5 minutos. **Ele não se auto-resolve com o problema de pé** — só apaga quando o backlog zera.

      Limite defendido por medição: entre 15/07 e 30/07 (janela saudável, 2.861 eventos
      `worker.mirror_requested`) o espelho fechou em p50 = 1,2s, p95 = 5,3min, p99 = 11min,
      **máximo 22,9min**. 2h é ~5x o pior caso observado.

      ## Modos de falha reais (em ordem de frequência observada)
      1. **Credencial inválida** — secret `anacare-api-key` (projeto `enlite-prd`) expirado/rotacionado.
         Foi o incidente de **30/07/2026 16:58 UTC**: toda escrita virou `HTTP 403 {"detail":"Invalid API key."}`,
         197 eventos falharam, 58 prestadores ficaram de fora, **11 dias sem ninguém ver**.
         Confirmar com: `SELECT error, count(*) FROM domain_events WHERE event='worker.mirror_requested'
         AND status='failed' AND created_at > now() - interval '2 days' GROUP BY 1;`
      2. **Falha de linking** (worker existe dos dois lados mas não casa) — `POST /api/v2/agencies/...`
         devolve erro de duplicado. Ver `workers.ana_care_sync_error`. Não re-tenta sozinho.
      3. **Ana Care fora do ar / timeout** — erro de rede em `domain_events.error`.
      4. **Evento nunca emitido** — worker virou REGISTERED sem `worker.mirror_requested`.
         Único modo que o `domain_events` não explica; casar `workers` contra `payload->>'workerId'`.

      ## Diagnóstico (nesta ordem)
      1. `GET /api/internal/events/health` → campo `anaCareMirror`
         (`stuckRecent`, `oldestStuckAgeHours`, `chronicTotal`).
      2. **`status='failed'` + a coluna `error`** — é aqui que mora a causa. NÃO basta olhar
         `status='pending'`: no incidente de 30/07 o pending estava zerado o tempo todo.
      3. Testar a credencial antes de culpar o código.

      ## Correção
      Rotacionar/corrigir o secret e então **reprocessar**: os eventos `failed` não voltam sozinhos.
      Usar `BackfillWorkerMirrorUseCase` (dryRun primeiro).

      ## Nota sobre `chronicTotal`
      Presos há mais de 7 dias saem da conta que dispara este alerta **de propósito**. São backlog
      histórico que não volta sozinho (modos 2 e 4). Se contassem, o alerta nasceria vermelho pra
      sempre e viraria ruído — que é exatamente o defeito que esta policy conserta.
      `chronicTotal` é reportado no log e no JSON para ficar visível sem paginar.
    EOT
  }

  # 7 dias: o alerta NÃO deve fechar sozinho por decurso de prazo. Enquanto o
  # espelho estiver quebrado o heartbeat renova; se o heartbeat sumir (serviço
  # fora do ar), fechar em silêncio seria a mesma mentira de 30/07.
  alert_strategy {
    auto_close = "604800s"
  }

  conditions {
    display_name = "existe prestador REGISTERED sem ana_care_id há mais de 2h"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/anacare_mirror_stuck\" AND resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"

      trigger {
        count = 1
      }

      # 1800s = 6 ciclos do cron de 5min. Um ciclo perdido (deploy, cold start,
      # scheduler atrasado) não zera a janela e não fabrica um "recovered".
      aggregations {
        alignment_period     = "1800s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }

  depends_on = [google_logging_metric.anacare_mirror_stuck]
}

# ---------------------------------------------------------------------------
# Monitor diário e2e-prod: alerta de FALHA DE EXECUÇÃO do Cloud Run Job
# ---------------------------------------------------------------------------
# Hoje, se o Job `e2e-prod-smoke` (roda às 3h AR) falha, ninguém é avisado. Ficou
# mais grave em 20/09/2026: esse mesmo job passou a executar também a rotina que
# sincroniza o Ana Care Horas — falha no meio dela deixa o mês parcial em prod, e
# sem tripwire ninguém percebe (foi essa lacuna, sem esta policy, que custou
# semanas com agosto/2026 fechado em 40%).
#
# Métrica NATIVA do Cloud Run Job (não é log-based, não precisa de
# google_logging_metric nem depends_on): run.googleapis.com/job/completed_execution_count,
# kind DELTA, resource cloud_run_job (labels project_id/job_name/location), com o
# label de métrica `result`. Confirmado em 20/09/2026 via
# docs.cloud.google.com/monitoring/api/metrics_gcp_p_z (#run/job/completed_execution_count)
# e docs.cloud.google.com/monitoring/api/resources (#tag_cloud_run_job).
resource "google_monitoring_alert_policy" "e2e_prod_smoke_execution_failed" {
  project      = var.project_id
  display_name = "[URGENTE] Monitor diário e2e-prod-smoke falhou (execução do Cloud Run Job)"
  combiner     = "OR"
  enabled      = true
  severity     = "CRITICAL"

  notification_channels = [var.events_notification_channel]

  documentation {
    mime_type = "text/markdown"
    subject   = "Execução do monitor diário e2e-prod-smoke falhou"
    content   = <<-EOT
      ## Impacto
      O Cloud Run Job `e2e-prod-smoke` roda todo dia às 3h (horário AR) e, desde 20/09/2026,
      essa mesma execução também é a rotina que sincroniza o **Ana Care Horas** do mês. Se o
      job falha — por exemplo por estourar o timeout com a sincronização pela metade — o mês
      fica **parcial em produção**, e sem este alerta ninguém percebe. Foi exatamente esse tipo
      de falha silenciosa que custou semanas com agosto/2026 fechado em 40%.

      ## O que este alerta afirma
      Existe pelo menos uma execução do job `e2e-prod-smoke` (projeto `enlite-prd`, região
      `southamerica-west1`) que terminou com `result="failed"` na métrica nativa
      `run.googleapis.com/job/completed_execution_count`.

      ## O que fazer ao receber
      1. Conferir a execução no Cloud Run: `gcloud run jobs executions list --job=e2e-prod-smoke
         --region=southamerica-west1 --project=enlite-prd` e os logs da execução que falhou.
      2. **Rodar a sincronização do Ana Care Horas até o fim.** O mês parcial NÃO se conserta
         sozinho só porque o job roda de novo amanhã — a lacuna de hoje fica aberta até alguém
         completar o sync manualmente.

      ## O que este alerta NÃO cobre
      Ele cobre a FALHA DO JOB, não a completude da sincronização. Uma execução que termina com
      `result="succeeded"` ainda pode ter sincronizado o mês pela metade se a lógica interna
      engolir um erro parcial — isso hoje **não é observável** e depende de trabalho futuro (uma
      coluna de status da corrida do sync). Um alerta que parecesse cobrir mais do que cobre
      seria pior que nenhum alerta: silêncio passaria a ser lido como "sincronizou completo",
      sem prova disso.
    EOT
  }

  # 1800s: este é um alerta de BORDA (uma execução falhou, evento pontual do dia), não
  # de ESTADO persistente como o anacare_mirror_stuck acima — não há razão pra manter
  # aberto depois que a condição para de ser verdadeira.
  alert_strategy {
    auto_close = "1800s"
  }

  conditions {
    display_name = "execução do job e2e-prod-smoke terminou com result=failed"
    condition_threshold {
      filter          = "resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"e2e-prod-smoke\" AND metric.type=\"run.googleapis.com/job/completed_execution_count\" AND metric.labels.result=\"failed\""
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
}
