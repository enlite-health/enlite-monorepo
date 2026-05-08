module "ar_worker_functions" {
  source        = "../../modules/artifact-registry"
  project_id    = var.project_id
  repository_id = "worker-functions"
  location      = "southamerica-west1"
}

module "ar_enlite_frontend" {
  source        = "../../modules/artifact-registry"
  project_id    = var.project_id
  repository_id = "enlite-frontend"
  location      = "us-central1"
}

# Repos auto-criados pelo Google (NÃO declarados aqui):
# - cloud-run-source-deploy: criado pelo `gcloud run deploy --source`
# - gcr.io: legacy Container Registry (deprecated, manter até zerar uso)
