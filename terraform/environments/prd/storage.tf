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

# spec 018, PR-4 (US-9, lex-pr4-foto.md #1-12): foto de perfil do paciente. SEPARADO do
# enlite-worker-documents (WEST1 vs EAST1; sem CORS — upload/leitura sempre pelo servidor).
# soft_delete_retention_days=0 para a revogação apagar de verdade. force_destroy=false explícito
# (default do módulo já é false — PRD nunca perde objeto por terraform destroy). IAM: só a SA do
# Cloud Run da API, roles/storage.objectAdmin NESTE bucket, sem cruzamento com a SA de stg.
# ⚠️ PRD: TRAVADA (checklists/lex.md, tasks.md:4.12) — só `terraform plan` até o Gabriel autorizar
# o `apply` na hora, com o texto do consentimento aprovado pelo jurídico (PH-1).
module "bucket_patient_photos" {
  source                      = "../../modules/storage"
  name                        = "enlite-patient-photos"
  location                    = "SOUTHAMERICA-WEST1"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  soft_delete_retention_days  = 0
  force_destroy                = false
}

resource "google_storage_bucket_iam_member" "patient_photos_functions_sa" {
  bucket = module.bucket_patient_photos.name
  role   = "roles/storage.objectAdmin"
  member = module.sa_enlite_functions.member
}

# spec 018, PR-4 (lex-pr4-documentos.md D329, #8 TRAVA o merge do PR-4): prova documental do
# consentimento/revogação de imagem. Bucket SEPARADO do da foto e do enlite-worker-documents;
# retenção própria (a prova sobrevive à revogação — só a purga do paciente apaga).
module "bucket_patient_documents" {
  source                      = "../../modules/storage"
  name                        = "enlite-patient-documents"
  location                    = "SOUTHAMERICA-WEST1"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  soft_delete_retention_days  = 0
  force_destroy                = false
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
