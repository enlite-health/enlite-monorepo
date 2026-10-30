# Repositorio de imagens do gestoras-service (plano 2 d: um repositorio por servico).
module "ar_gestoras_service" {
  source        = "../../modules/artifact-registry"
  project_id    = var.project_id
  repository_id = "gestoras-service"
  location      = var.region
}
