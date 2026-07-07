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
