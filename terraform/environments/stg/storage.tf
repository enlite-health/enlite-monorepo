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

# Documento (prova do consentimento) e consentimento de imagem — que tinham bucket próprio aqui
# (`bucket_patient_documents`, spec 018 PR-4) — foram REMOVIDOS por completo
# (fix/018-remover-documentos-consentimento). Nunca chegaram a `prd`; o bucket
# `enlite-patient-documents-stg` sai por `terraform apply` na `stg` (destroy real do módulo, sem
# dado a reconciliar — mesma trava desarmar→importar→alinhar não se aplica: não há recurso criado
# à mão nem drift a fechar aqui, só a remoção do bloco).
