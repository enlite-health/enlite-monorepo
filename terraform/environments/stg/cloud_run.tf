# Cloud Run em stg: skeleton dos services (CPU, mem, SA, Cloud SQL).
# Imagem e env vars são gerenciadas pelo CI/CD do branch staging
# (lifecycle ignore_changes no módulo).
#
# ⚠️ DIMENSIONAMENTO: quem manda de fato é o CI. Os 3 workflows de stg
# (backend-stg.yml, frontend-stg.yml, backend-mcp-stg.yml) deployam com
# `--cpu=1 --memory=512Mi --min-instances=0 --max-instances=3` a cada push.
# Os valores abaixo estavam com números de prd (cpu 2, 1Gi, max 10, min 1) e o
# `plan` ficava pedindo update in-place eternamente — um apply feito para outra
# coisa REDIMENSIONARIA o staging inteiro, e `min_scale = 1` ainda passaria a
# cobrar instância parada. Alinhado à realidade em 13/08/2026 (D106: o código
# reflete o que existe). Mudar aqui sem mudar o workflow não tem efeito: o
# próximo deploy desfaz.
#
# IMPORTANTE: prd NÃO está sob Terraform. Foi criado manualmente; importar
# os 3 services v1 (knative-style) pra schema v2 é trabalhoso e fora do
# escopo da Fase 1. Documentado em FOLLOWUPS como TD.

data "google_project" "this" {
  project_id = var.project_id
}

locals {
  cloud_sql_ar = "enlite-stg:southamerica-west1:enlite-ar-db"

  # Placeholder Google "hello" image até o CI/CD fazer push da primeira imagem real
  placeholder_image = "us-docker.pkg.dev/cloudrun/container/hello"

  default_compute_sa = "${data.google_project.this.number}-compute@developer.gserviceaccount.com"
}

module "cloud_run_enlite_frontend" {
  source                = "../../modules/cloud-run"
  project_id            = var.project_id
  name                  = "enlite-frontend"
  location              = "southamerica-west1"
  image                 = local.placeholder_image
  service_account_email = local.default_compute_sa
  cpu_limit             = "1"
  memory_limit          = "512Mi"
  max_scale             = 3
  min_scale             = 0
}

module "cloud_run_worker_functions" {
  source                = "../../modules/cloud-run"
  project_id            = var.project_id
  name                  = "worker-functions"
  location              = "southamerica-west1"
  image                 = local.placeholder_image
  service_account_email = module.sa_enlite_functions.email
  cpu_limit             = "1"
  memory_limit          = "512Mi"
  max_scale             = 3
  min_scale             = 0

  cloud_sql_instances = [local.cloud_sql_ar]

  depends_on = [module.sql_enlite_ar_db]
}

module "cloud_run_worker_functions_mcp" {
  source                = "../../modules/cloud-run"
  project_id            = var.project_id
  name                  = "worker-functions-mcp"
  location              = "southamerica-west1"
  image                 = local.placeholder_image
  service_account_email = module.sa_enlite_functions.email
  cpu_limit             = "1"
  memory_limit          = "512Mi"
  max_scale             = 3
  min_scale             = 0

  # Ingress restrito: só tráfego VPC interno + serviços GCP do mesmo projeto
  ingress = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  cloud_sql_instances = [local.cloud_sql_ar]

  depends_on = [module.sql_enlite_ar_db]
}
