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

# Buckets gerenciados pelo Google (NÃO declarados aqui):
# - enlite-prd_cloudbuild                     → criado pelo Cloud Build
# - run-sources-enlite-prd-southamerica-west1 → criado pelo Cloud Run pra source deploys
# - enlite-tf-state                           → criado fora do TF (bootstrap)
