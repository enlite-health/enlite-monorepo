module "bucket_worker_documents" {
  source                      = "../../modules/storage"
  name                        = "enlite-worker-documents"
  location                    = "SOUTHAMERICA-EAST1"
  uniform_bucket_level_access = true

  cors = [{
    origins = [
      "https://enlite-frontend-121472682203.southamerica-west1.run.app",
      "https://app.enlite.health",
      "http://localhost:3000",
      "http://localhost:5173",
    ]
    methods          = ["GET", "PUT", "OPTIONS"]
    response_headers = ["Content-Type", "Content-Length"]
    max_age_seconds  = 3600
  }]
}

# spec 018, PR-4 (US-9, lex-pr4-foto.md #1-12): foto de perfil do paciente. Equivalente de prd do
# `bucket_patient_photos` da `stg` (`terraform/environments/stg/storage.tf`) — mesmo desenho: região
# SOUTHAMERICA-WEST1 (não EAST1 como o `bucket_worker_documents`, que é do prestador), sem CORS
# (upload/leitura sempre pelo servidor, nunca URL assinada de escrita no navegador),
# soft_delete_retention_days=0 para a revogação apagar de verdade (o módulo usa 7 por default).
# Criado pela promoção `stage`→`main` (openspec/changes/promocao-stage-para-main, Fase B, item 3):
# `GCS_PATIENT_PHOTOS_BUCKET` não tinha equivalente em prd e o código é fail-closed só na hora de
# assinar a URL (não no boot) — sem este bucket, a feature de foto quebra em uso.
module "bucket_patient_photos" {
  source                      = "../../modules/storage"
  name                        = "enlite-patient-photos"
  location                    = "SOUTHAMERICA-WEST1"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  soft_delete_retention_days  = 0
}

resource "google_storage_bucket_iam_member" "patient_photos_functions_sa" {
  bucket = module.bucket_patient_photos.name
  role   = "roles/storage.objectAdmin"
  member = module.sa_enlite_functions.member
}

# spec 022 (chat interno por paciente), Bloco 3 — anexos de mensagem (PDF/PNG/JPG/.docx). Recolocado
# em prd por D-25: o módulo nasceu em `aac26926` e saiu em `4a27d1ed` ("PRD fora de escopo"); o HCL
# abaixo é o bloco recuperado (`evidencias/hcl-bucket-removido.txt`), sem alteração de desenho.
# Mesmo desenho do `bucket_patient_photos` ao lado: SOUTHAMERICA-WEST1, sem CORS (upload/download
# sempre pelo servidor, nunca URL assinada de escrita no navegador), acesso público bloqueado,
# soft_delete_retention_days=0 para a exclusão apagar de verdade (o módulo usa 7 por default),
# sem versionamento e sem regra de lifecycle. `force_destroy = false` explícito: é dado de paciente.
module "bucket_patient_documents" {
  source                      = "../../modules/storage"
  name                        = "enlite-patient-documents"
  location                    = "SOUTHAMERICA-WEST1"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  soft_delete_retention_days  = 0
  force_destroy               = false
}

resource "google_storage_bucket_iam_member" "patient_documents_functions_sa" {
  bucket = module.bucket_patient_documents.name
  role   = "roles/storage.objectAdmin"
  member = module.sa_enlite_functions.member
}

# Buckets gerenciados pelo Google (NÃO declarados aqui):
# - enlite-prd_cloudbuild                     → criado pelo Cloud Build
# - run-sources-enlite-prd-southamerica-west1 → criado pelo Cloud Run pra source deploys
# - enlite-tf-state                           → criado fora do TF (bootstrap)
