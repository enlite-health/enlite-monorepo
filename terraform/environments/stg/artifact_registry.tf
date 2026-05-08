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
