# Image repository for assistants-service (plan 2 d: one repository per service).
module "ar_assistants_service" {
  source        = "../../modules/artifact-registry"
  project_id    = var.project_id
  repository_id = "assistants-service"
  location      = var.region
}
