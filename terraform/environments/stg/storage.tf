module "bucket_n8n_backups" {
  source                      = "../../modules/storage"
  name                        = "enlite-n8n-backups-ar-stg"
  location                    = "SOUTHAMERICA-WEST1"
  uniform_bucket_level_access = false
}

module "bucket_n8n_temp_sql" {
  source                      = "../../modules/storage"
  name                        = "enlite-n8n-temp-sql-stg"
  location                    = "SOUTHAMERICA-WEST1"
  uniform_bucket_level_access = false
}

module "bucket_worker_documents" {
  source                      = "../../modules/storage"
  name                        = "enlite-worker-documents-stg"
  location                    = "SOUTHAMERICA-EAST1"
  uniform_bucket_level_access = true

  # CORS provisório: ajustar quando frontend stg for deployado e domínio
  # de stg estiver decidido (placeholder: stg.enlite.health).
  cors = [{
    origins = [
      "https://enlite-frontend-823776126002.southamerica-west1.run.app",
      "https://stg.enlite.health",
      "https://enlite-n8n-823776126002.southamerica-west1.run.app",
      "http://localhost:3000",
      "http://localhost:5173",
    ]
    methods          = ["GET", "PUT", "OPTIONS"]
    response_headers = ["Content-Type", "Content-Length"]
    max_age_seconds  = 3600
  }]
}
