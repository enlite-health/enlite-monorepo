# IAM das gestoras (spec 080). Molde: luz-store/cloud_sql_luz_knowledge.tf:89-112.
# Regra: SO *_iam_member (aditivo). NUNCA *_binding/*_policy -- reescreveriam o IAM de quem ja tem acesso.

# -- SA do servico (Cloud Run gestoras-service) ---------------------------------
# project_roles do modulo usa google_project_iam_member (aditivo).
module "gestoras_service_sa" {
  source       = "../../modules/service-account"
  project_id   = var.project_id
  account_id   = "gestoras-service-sa"
  display_name = "Gestoras service (Cloud Run)"
  description  = "Identidade do Cloud Run gestoras-service (spec 080)"
  project_roles = [
    "roles/cloudsql.client",
    "roles/aiplatform.user",
  ]
}

# -- SA do scheduler: SEM papel (so assina o OIDC do job; sem binding de projeto) --
module "gestoras_scheduler_sa" {
  source        = "../../modules/service-account"
  project_id    = var.project_id
  account_id    = "gestoras-scheduler-sa"
  display_name  = "Gestoras scheduler"
  description   = "Identidade do Cloud Scheduler da retencao (spec 080); sem papeis"
  project_roles = []
}

# -- Secrets: o servico le SO app e sistema (nunca o do dono) --------------------
resource "google_secret_manager_secret_iam_member" "gestoras_app_accessor" {
  project   = var.project_id
  secret_id = module.secret_gestoras_db_app.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = module.gestoras_service_sa.member
}

resource "google_secret_manager_secret_iam_member" "gestoras_sistema_accessor" {
  project   = var.project_id
  secret_id = module.secret_gestoras_db_sistema.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = module.gestoras_service_sa.member
}

# -- SA de deploy: le o secret do DONO (roda a migration) e age como a SA do servico --
resource "google_secret_manager_secret_iam_member" "gestoras_owner_accessor_deploy" {
  project   = var.project_id
  secret_id = module.secret_gestoras_db_owner.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.deploy_sa_email}"
}

resource "google_service_account_iam_member" "deploy_acts_as_service_sa" {
  service_account_id = module.gestoras_service_sa.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${var.deploy_sa_email}"
}

# -- Bucket de conhecimento (decisao 24): o servico so LE. Aditivo; bucket nao e nosso. --
resource "google_storage_bucket_iam_member" "gestoras_conhecimento_viewer" {
  bucket = "enlite-agentes-conhecimento"
  role   = "roles/storage.objectViewer"
  member = module.gestoras_service_sa.member
}
