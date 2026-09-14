module "bucket_worker_documents" {
  source                      = "../../modules/storage"
  name                        = "enlite-worker-documents-stg"
  location                    = "SOUTHAMERICA-EAST1"
  uniform_bucket_level_access = true

  # Domínio de QAS: qas.enlite.health (Firebase Hosting site enlite-stg → Cloud Run)
  cors = [{
    origins = [
      "https://enlite-frontend-vtf37eainq-tl.a.run.app",
      "https://enlite-frontend-823776126002.southamerica-west1.run.app",
      "https://qas.enlite.health",
      "http://localhost:3000",
      "http://localhost:5173",
    ]
    methods          = ["GET", "PUT", "POST", "OPTIONS"]
    response_headers = ["Content-Type", "Content-Length", "x-goog-resumable"]
    max_age_seconds  = 3600
  }]
}

# spec 018, PR-4 (US-9, lex-pr4-foto.md #1-12): foto de perfil do paciente. SEPARADO do
# enlite-worker-documents (region diferente: WEST1 vs EAST1 do prestador; sem CORS — upload/leitura
# sempre pelo servidor, nunca URL assinada de escrita no navegador). soft_delete_retention_days=0
# para a revogação apagar de verdade (o módulo usa 7 por default). IAM: só a SA do Cloud Run da
# API, roles/storage.objectAdmin NESTE bucket — sem allUsers/allAuthenticatedUsers.
module "bucket_patient_photos" {
  source                      = "../../modules/storage"
  name                        = "enlite-patient-photos-stg"
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

# spec 018, PR-4 (lex-pr4-documentos.md D329, #8 TRAVA o merge do PR-4): prova documental do
# consentimento/revogação de imagem. Bucket SEPARADO do da foto (retenção própria — a prova
# sobrevive à revogação, só a purga do paciente apaga) e do enlite-worker-documents. Mesma forma
# de segurança do bucket de foto; sem versionamento/retention policy/lock/hold.
module "bucket_patient_documents" {
  source                      = "../../modules/storage"
  name                        = "enlite-patient-documents-stg"
  location                    = "SOUTHAMERICA-WEST1"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  soft_delete_retention_days  = 0
}

resource "google_storage_bucket_iam_member" "patient_documents_functions_sa" {
  bucket = module.bucket_patient_documents.name
  role   = "roles/storage.objectAdmin"
  member = module.sa_enlite_functions.member
}
