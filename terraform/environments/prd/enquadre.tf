# ---------------------------------------------------------------------------
# Enquadre (spec 052, Fase 3) — cofre da transcrição e agendadores da esteira pós-call
# ---------------------------------------------------------------------------
# ⚠️ ESTES RECURSOS NÃO FORAM APLICADOS. Escritos para revisão: falta o "vai" do Gabriel (regra do CLAUDE.md:
# infra de prd para antes do apply). Todos NOVOS — nenhum import. Molde: `admission.tf` (NÃO editado).
#
# Ordem (desarmar → importar → alinhar): nada do enquadre existe em prd → nada a desarmar nem importar; este arquivo é o "alinhar".
# O state da admissão devolve 403 em storage.buckets.get (conta pessoal fora do IAM autoritativo): o plan e o apply deste arquivo
# vão SÓ com `-target` nos endereços abaixo.
#
# Reaproveita do `admission.tf` (sem copiar): `local.admission_region`, `local.admission_tf_admin_member`,
# `var.admission_vault_readers` (a mesma lista de resgate), `var.admission_vault_retention_seconds`, o agente de serviço do GCS
# (`data.google_storage_project_service_account.gcs`) e o secret `internal-token-secret`.
#
# Env do Cloud Run (ENQUADRE_TRANSCRIPT_VAULT_BUCKET) NÃO é deste arquivo: vive em `.github/workflows/backend-prd.yml`.
# Sem bucket de ensaio, sem métricas e sem alertas por ora (lista de pendências da fase).

locals {
  # Os 2 jobs do enquadre (separados dos da admissão — D506). Mesma cadência: post-call a cada 15 min, import defasado 7 min
  # (o import lê o que o post-call acabou de fechar).
  enquadre_jobs = {
    enquadre-post-call = {
      schedule = "*/15 * * * *"
      path     = "/api/internal/jobs/enquadre-post-call"
    }
    enquadre-import = {
      schedule = "7,22,37,52 * * * *"
      path     = "/api/internal/jobs/enquadre-import"
    }
  }
}

# ---------------------------------------------------------------------------
# Cofre: chave KMS própria + bucket CMEK
# ---------------------------------------------------------------------------
resource "google_kms_key_ring" "enquadre_vault" {
  project  = var.project_id
  name     = "enquadre-vault"
  location = local.admission_region
}

resource "google_kms_crypto_key" "enquadre_transcripts" {
  name            = "enquadre-transcripts"
  key_ring        = google_kms_key_ring.enquadre_vault.id
  purpose         = "ENCRYPT_DECRYPT"
  rotation_period = "31536000s" # anual

  lifecycle {
    prevent_destroy = true
  }
}

# O bucket cifra/decifra pela identidade do agente de serviço do Storage — o backend NÃO recebe permissão na chave.
resource "google_kms_crypto_key_iam_member" "enquadre_vault_gcs_agent" {
  crypto_key_id = google_kms_crypto_key.enquadre_transcripts.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${data.google_storage_project_service_account.gcs.email_address}"
}

# Sem o módulo `storage`: ele não expõe CMEK/versionamento/retention (T13). Mesmos atributos do cofre da admissão.
resource "google_storage_bucket" "enquadre_transcripts" {
  project                     = var.project_id
  name                        = "enlite-enquadre-transcripts-prd"
  location                    = "SOUTHAMERICA-WEST1"
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  encryption {
    default_kms_key_name = google_kms_crypto_key.enquadre_transcripts.id
  }

  versioning {
    enabled = true
  }

  soft_delete_policy {
    retention_duration_seconds = 90 * 86400
  }

  # Destravada de propósito (mesma decisão da admissão): is_locked é irreversível.
  retention_policy {
    retention_period = var.admission_vault_retention_seconds
    is_locked        = false
  }

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_kms_crypto_key_iam_member.enquadre_vault_gcs_agent]
}

# IAM do cofre: política AUTORITATIVA (mesmo motivo da admissão: tira os vínculos legacy padrão de projectViewer/Editor/Owner).
# - Backend: SÓ cria objeto. Não lê, não lista, não apaga, não sobrescreve.
# - Leitura: só o resgate (`var.admission_vault_readers`). Lista vazia = nenhum binding.
# - tf-admin: legacyBucketOwner EXPLÍCITO e só dele (administra o bucket, não lê a transcrição).
data "google_iam_policy" "enquadre_transcripts" {
  binding {
    role    = "roles/storage.objectCreator"
    members = [module.sa_enlite_functions.member]
  }

  dynamic "binding" {
    for_each = length(var.admission_vault_readers) > 0 ? [1] : []
    content {
      role    = "roles/storage.objectViewer"
      members = var.admission_vault_readers
    }
  }

  binding {
    role    = "roles/storage.legacyBucketOwner"
    members = [local.admission_tf_admin_member]
  }
}

resource "google_storage_bucket_iam_policy" "enquadre_transcripts" {
  bucket      = google_storage_bucket.enquadre_transcripts.name
  policy_data = data.google_iam_policy.enquadre_transcripts.policy_data
}

# ---------------------------------------------------------------------------
# Schedulers (molde: admission.tf — X-Internal-Secret do secret internal-token-secret). ATIVOS (Gabriel, 14/10).
# ---------------------------------------------------------------------------
resource "google_cloud_scheduler_job" "enquadre" {
  for_each = local.enquadre_jobs

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
