# ---------------------------------------------------------------------------
# Aba Admissão (spec 049, F8) — cofre da transcrição, auditoria, schedulers, métricas e alertas
# ---------------------------------------------------------------------------
# ⚠️ ESTES RECURSOS NÃO FORAM APLICADOS. Escritos para revisão: falta o "vai" do Gabriel (regra do CLAUDE.md:
# infra de prd para antes do apply). Todos NOVOS — nenhum import. A fila Cloud Tasks `admission-reminders` foi criada à mão
# e NÃO entra no state (spec §11, só com a palavra do Gabriel). A chave de dados `enlite-keyring/worker-data-key` também
# está FORA do terraform e não é importada aqui (a chave do cofre é outra, própria).
#
# Ordem (desarmar → importar → alinhar): `auditConfigs=null` em prd (medido) → nada a desarmar; nenhum recurso da 049 existe
# → nada a importar; este arquivo é o "alinhar".
#
# Envs do Cloud Run (ADMISSION_TRANSCRIPT_VAULT_BUCKET, TACTIQ_*, ...) NÃO são deste arquivo: ver o runbook.

# H5 (Gabriel, 09/10): resgate = 4 contas @enlite.health do Acesso Master; o gmail pessoal fica fora de propósito.
# IAM do GCP não enxerga grupo do app: lista de membros IAM completos ("user:x@enlite.health" / "group:y@enlite.health").
# Os valores vivem AQUI (HCL versionado), não no terraform.tfvars (gitignorado). Lista vazia = ninguém lê.
variable "admission_vault_readers" {
  type        = list(string)
  description = "Membros IAM com leitura (roles/storage.objectViewer) do cofre da transcrição — o resgate. Vazio = ninguém lê."
  default = [
    "user:marcel@enlite.health",
    "user:javier.bernal@enlite.health",
    "user:diego.trevisan@enlite.health",
    "user:gabriel.stein@enlite.health",
  ]
}

variable "admission_vault_retention_seconds" {
  type        = number
  description = "Retenção do cofre, SEM trava (is_locked fica false). H6 (Gabriel, 09/10): 5 anos (5 × 365 × 86400). Destravada, a política pode ser encurtada ou removida — o Bucket Lock é irreversível e só entra depois."
  default     = 157680000
}

locals {
  admission_region = "southamerica-west1"
  # Os 3 jobs da 049. post-call e import rodam a cada 15 min, import defasado 7 min (o import lê o que o post-call acabou de fechar).
  admission_jobs = {
    admission-post-call = {
      schedule = "*/15 * * * *"
      path     = "/api/internal/jobs/admission-post-call"
    }
    admission-import = {
      schedule = "7,22,37,52 * * * *"
      path     = "/api/internal/jobs/admission-import"
    }
    # Diário 12:00 UTC = 09:00 em Buenos Aires (sem horário de verão).
    admission-tactiq-check = {
      schedule = "0 12 * * *"
      path     = "/api/internal/jobs/admission-tactiq-check"
    }
  }
}

# ---------------------------------------------------------------------------
# Cofre: chave KMS própria + bucket CMEK
# ---------------------------------------------------------------------------
resource "google_kms_key_ring" "admission_vault" {
  project  = var.project_id
  name     = "admission-vault"
  location = local.admission_region
}

resource "google_kms_crypto_key" "admission_transcripts" {
  name            = "admission-transcripts"
  key_ring        = google_kms_key_ring.admission_vault.id
  purpose         = "ENCRYPT_DECRYPT"
  rotation_period = "31536000s" # anual

  lifecycle {
    prevent_destroy = true
  }
}

# O bucket cifra/decifra pela identidade do agente de serviço do Storage — o backend NÃO recebe permissão na chave.
data "google_storage_project_service_account" "gcs" {
  project = var.project_id
}

resource "google_kms_crypto_key_iam_member" "admission_vault_gcs_agent" {
  crypto_key_id = google_kms_crypto_key.admission_transcripts.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${data.google_storage_project_service_account.gcs.email_address}"
}

# Sem o módulo `storage`: ele não expõe CMEK/versionamento/retention (T13).
resource "google_storage_bucket" "admission_transcripts" {
  project                     = var.project_id
  name                        = "enlite-admission-transcripts-prd"
  location                    = "SOUTHAMERICA-WEST1"
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  encryption {
    default_kms_key_name = google_kms_crypto_key.admission_transcripts.id
  }

  versioning {
    enabled = true
  }

  soft_delete_policy {
    retention_duration_seconds = 90 * 86400
  }

  # Destravada de propósito (H6): is_locked é irreversível.
  retention_policy {
    retention_period = var.admission_vault_retention_seconds
    is_locked        = false
  }

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_kms_crypto_key_iam_member.admission_vault_gcs_agent]
}

# Backend: SÓ cria objeto (upload com ifGenerationMatch=0). Não lê, não lista, não apaga, não sobrescreve.
resource "google_storage_bucket_iam_member" "admission_transcripts_backend_creator" {
  bucket = google_storage_bucket.admission_transcripts.name
  role   = "roles/storage.objectCreator"
  member = module.sa_enlite_functions.member
}

# Leitura: só os membros do resgate (H5). Lista vazia = nenhum binding.
resource "google_storage_bucket_iam_member" "admission_transcripts_readers" {
  for_each = toset(var.admission_vault_readers)
  bucket   = google_storage_bucket.admission_transcripts.name
  role     = "roles/storage.objectViewer"
  member   = each.value
}

# ---------------------------------------------------------------------------
# Auditoria: Data Access logs (leitura e escrita) de Storage e KMS
# ---------------------------------------------------------------------------
# `google_project_iam_audit_config` é AUTORITATIVO por serviço. `auditConfigs=null` em prd (medido 09/10/2026), então nada
# some. ⚠️ É por PROJETO: liga o Data Access de TODOS os buckets (worker-documents, patient-photos, patient-documents) e do
# KMS de dados — o volume de log e o custo sobem; o escopo por bucket não existe (só exempted_members). Decisão de custo
# no apply.
resource "google_project_iam_audit_config" "storage" {
  project = var.project_id
  service = "storage.googleapis.com"

  audit_log_config {
    log_type = "DATA_READ"
  }
  audit_log_config {
    log_type = "DATA_WRITE"
  }
}

resource "google_project_iam_audit_config" "kms" {
  project = var.project_id
  service = "cloudkms.googleapis.com"

  audit_log_config {
    log_type = "DATA_READ"
  }
  audit_log_config {
    log_type = "DATA_WRITE"
  }
}

# ---------------------------------------------------------------------------
# Schedulers (molde: events.tf — X-Internal-Secret do secret internal-token-secret)
# ---------------------------------------------------------------------------
resource "google_cloud_scheduler_job" "admission" {
  for_each = local.admission_jobs

  project          = var.project_id
  region           = var.scheduler_region
  name             = each.key
  schedule         = each.value.schedule
  time_zone        = "Etc/UTC"
  attempt_deadline = "300s"

  # Retry curto: os jobs são idempotentes e o Scheduler é "at least once".
  retry_config {
    retry_count          = 2
    max_backoff_duration = "3600s"
    max_doublings        = 5
    max_retry_duration   = "0s"
    min_backoff_duration = "5s"
  }

  http_target {
    http_method = "POST"
    uri         = "${var.events_api_base_url}${each.value.path}"
    body        = base64encode("{}")
    headers = {
      "Content-Type"      = "application/json"
      "X-Internal-Secret" = data.google_secret_manager_secret_version.internal_token.secret_data
    }
  }
}

# ---------------------------------------------------------------------------
# Métricas de log + alertas (jsonPayload.message — o logger usa messageKey 'message')
# ---------------------------------------------------------------------------
# Nomes conferidos 1:1 com o código (worker-functions/src/modules/matching). `import_rejected`, `import_ambiguous`
# e `import_expired` saem como `admission.${kind}` (template) em AdmissionImportService.terminal()/expire().
# ⚠️ No código, import_expired/rejected/ambiguous logam em ERROR (não warn): o filtro é pela mensagem, então a severidade
# do log não importa; o alerta delas fica em ATENÇÃO (decisão de produto: é fila de revisão humana, não incidente).
locals {
  admission_log_alerts = {
    # Incidente (URGENTE): o dado/arquivo não chegou onde devia.
    import_blocked = {
      message  = "admission.import_blocked"
      severity = "ERROR"
      what     = "Importação do Tactiq BLOQUEADA (ex.: conta errada, host sem vínculo). A transcrição não entra."
    }
    silence_detector_failed = {
      message  = "admission.silence.detector_failed"
      severity = "ERROR"
      what     = "O detector de silêncio da admissão falhou: lembrete/confirmação pode não ter saído."
    }
    post_call_step_failed = {
      message  = "admission.post_call.step_failed"
      severity = "ERROR"
      what     = "Um passo do job de 15 min (fim da call, no_show) falhou."
    }
    vault_write_failed = {
      message  = "admission.vault_write_failed"
      severity = "ERROR"
      what     = "Gravação no cofre da transcrição FALHOU (bucket/chave KMS/permissão)."
    }
    summary_failed = {
      message  = "admission.summary_failed"
      severity = "ERROR"
      what     = "O resumo via Vertex falhou (cota, modelo, permissão aiplatform.user)."
    }
    # Atenção: acompanhamento humano.
    no_show = {
      message  = "admission.no_show"
      severity = "WARNING"
      what     = "Candidato não compareceu (no_show) à call de admissão."
    }
    silence_reminder = {
      message  = "admission.silence.reminder"
      severity = "WARNING"
      what     = "Silêncio detectado após o lembrete: o candidato não respondeu."
    }
    silence_confirmation = {
      message  = "admission.silence.confirmation"
      severity = "WARNING"
      what     = "Silêncio detectado após a confirmação: o candidato não respondeu."
    }
    post_call_meet_transient = {
      message  = "admission.post_call.meet_transient"
      severity = "WARNING"
      what     = "A Meet API falhou de forma transitória (o job tenta de novo no próximo ciclo)."
    }
    import_expired = {
      message  = "admission.import_expired"
      severity = "WARNING"
      what     = "Importação do Tactiq EXPIRADA: a transcrição não apareceu a tempo."
    }
    import_rejected = {
      message  = "admission.import_rejected"
      severity = "WARNING"
      what     = "Importação do Tactiq REJEITADA (integridade/regra): exige revisão humana."
    }
    import_ambiguous = {
      message  = "admission.import_ambiguous"
      severity = "WARNING"
      what     = "Importação do Tactiq AMBÍGUA (mais de um candidato): exige revisão humana."
    }
    tactiq_link_missing_48h = {
      message  = "admission.tactiq_link.missing_48h"
      severity = "WARNING"
      what     = "Operadora há mais de 48 h sem vínculo do Tactiq: as transcrições dela não são importadas."
    }
    tactiq_link_broken = {
      message  = "admission.tactiq_link.broken"
      severity = "WARNING"
      what     = "O vínculo do Tactiq de uma operadora QUEBROU no teste diário."
    }
  }
}

resource "google_logging_metric" "admission" {
  for_each = local.admission_log_alerts

  project     = var.project_id
  name        = "admission_${each.key}"
  description = "Admissão (spec 049): ${each.value.message}"
  filter      = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"worker-functions\" AND jsonPayload.message=\"${each.value.message}\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_monitoring_alert_policy" "admission" {
  for_each = local.admission_log_alerts

  project      = var.project_id
  display_name = "${each.value.severity == "ERROR" ? "[URGENTE]" : "[ATENÇÃO]"} Admissão: ${each.value.message}"
  combiner     = "OR"
  enabled      = true
  severity     = each.value.severity == "ERROR" ? "ERROR" : "WARNING"

  notification_channels = [var.events_notification_channel]

  documentation {
    mime_type = "text/markdown"
    subject   = "Admissão: ${each.value.message}"
    content   = "${each.value.what}\n\nLog: `jsonPayload.message=\"${each.value.message}\"` no `worker-functions`. A linha traz `appointmentId` e o motivo (`reason`) — nunca nome, e-mail nem texto da transcrição."
  }

  alert_strategy {
    auto_close = "1800s"
  }

  conditions {
    display_name = "${each.value.message} > 0 em 5 min"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/admission_${each.key}\" AND resource.type=\"cloud_run_revision\""
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

  depends_on = [google_logging_metric.admission]
}

# Sinal de vida: job parado é SILÊNCIO. `admission.post_call.run_done` sai a cada execução (15 min); 45 min sem ele = 3 ciclos perdidos.
resource "google_logging_metric" "admission_post_call_run_done" {
  project     = var.project_id
  name        = "admission_post_call_run_done"
  description = "Admissão (spec 049): sinal de vida do job de 15 min (admission.post_call.run_done)"
  filter      = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"worker-functions\" AND jsonPayload.message=\"admission.post_call.run_done\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_monitoring_alert_policy" "admission_post_call_stopped" {
  project      = var.project_id
  display_name = "[URGENTE] Admissão: job de 15 min PARADO (sem admission.post_call.run_done há 45 min)"
  combiner     = "OR"
  enabled      = true
  severity     = "ERROR"

  notification_channels = [var.events_notification_channel]

  documentation {
    mime_type = "text/markdown"
    subject   = "Job de 15 min da admissão parado"
    content   = "Nenhum `admission.post_call.run_done` em 45 min: o fim real da call, o no_show e os detectores de silêncio não estão rodando. Conferir: `gcloud scheduler jobs describe admission-post-call --location=southamerica-east1` (existe? PAUSED?) e os logs de `/api/internal/jobs/admission-post-call`. Se o job nunca foi aplicado, este alerta só passa a valer depois do primeiro run_done."
  }

  alert_strategy {
    auto_close = "1800s"
  }

  conditions {
    display_name = "sem admission.post_call.run_done há 45 min"
    condition_absent {
      filter   = "metric.type=\"logging.googleapis.com/user/admission_post_call_run_done\" AND resource.type=\"cloud_run_revision\""
      duration = "2700s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }

  depends_on = [google_logging_metric.admission_post_call_run_done]
}

# Cofre LIDO: toda leitura do bucket (Data Access) vira e-mail. Leitura é evento raro e deve ser vista (spec §4.4).
# O backend só cria objeto (DATA_WRITE), então qualquer storage.objects.get/list no bucket é leitura humana (resgate) —
# ou intrusão.
resource "google_logging_metric" "admission_vault_read" {
  project     = var.project_id
  name        = "admission_vault_read"
  description = "Admissão (spec 049): leitura/listagem de objeto no cofre da transcrição (Data Access)"
  filter      = "protoPayload.serviceName=\"storage.googleapis.com\" AND resource.type=\"gcs_bucket\" AND resource.labels.bucket_name=\"${google_storage_bucket.admission_transcripts.name}\" AND protoPayload.methodName=(\"storage.objects.get\" OR \"storage.objects.list\")"

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_monitoring_alert_policy" "admission_vault_read" {
  project      = var.project_id
  display_name = "[URGENTE] Cofre da transcrição da admissão LIDO"
  combiner     = "OR"
  enabled      = true
  severity     = "ERROR"

  notification_channels = [var.events_notification_channel]

  documentation {
    mime_type = "text/markdown"
    subject   = "Alguém leu o cofre da transcrição da admissão"
    content   = "Houve `storage.objects.get`/`list` em `enlite-admission-transcripts-prd`. O backend só grava; leitura é o resgate jurídico (runbook `RUNBOOK_COFRE_TRANSCRICAO_ADMISSAO.md`) ou intrusão. Conferir quem (`protoPayload.authenticationInfo.principalEmail` no Logs Explorer) e se havia concessão aberta."
  }

  alert_strategy {
    auto_close = "1800s"
  }

  conditions {
    display_name = "leitura no cofre > 0"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/admission_vault_read\" AND resource.type=\"gcs_bucket\""
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

  depends_on = [google_logging_metric.admission_vault_read]
}
