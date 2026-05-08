module "bucket_n8n_backups" {
  source                      = "../../modules/storage"
  name                        = "enlite-n8n-backups-ar"
  location                    = "SOUTHAMERICA-WEST1"
  uniform_bucket_level_access = false
}

module "bucket_n8n_temp_sql" {
  source                      = "../../modules/storage"
  name                        = "enlite-n8n-temp-sql"
  location                    = "SOUTHAMERICA-WEST1"
  uniform_bucket_level_access = false
}

module "bucket_worker_documents" {
  source                      = "../../modules/storage"
  name                        = "enlite-worker-documents"
  location                    = "SOUTHAMERICA-EAST1"
  uniform_bucket_level_access = true

  cors = [{
    origins = [
      "https://enlite-frontend-121472682203.southamerica-west1.run.app",
      "https://app.enlite.health",
      "https://enlite-n8n-121472682203.southamerica-west1.run.app",
      "https://n8n.enlite.health",
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
