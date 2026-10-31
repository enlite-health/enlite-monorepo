# IAM for the assistants (spec 080). Molde: luz-store/cloud_sql_luz_knowledge.tf:89-112.
# Rule: ONLY *_iam_member (additive). NEVER *_binding/*_policy -- they would rewrite the IAM of whoever already has access.

# -- Service SA (Cloud Run assistants-service) ---------------------------------
# The module's project_roles uses google_project_iam_member (additive).
module "assistants_service_sa" {
  source       = "../../modules/service-account"
  project_id   = var.project_id
  account_id   = "assistants-service-sa"
  display_name = "Assistants service (Cloud Run)"
  description  = "Identity of the assistants-service Cloud Run (spec 080)"
  project_roles = [
    "roles/cloudsql.client",
    "roles/aiplatform.user",
  ]
}

# -- Scheduler SA: NO role (only signs the job's OIDC; no project binding) --
module "assistants_scheduler_sa" {
  source        = "../../modules/service-account"
  project_id    = var.project_id
  account_id    = "assistants-scheduler-sa"
  display_name  = "Assistants scheduler"
  description   = "Identity of the retention Cloud Scheduler (spec 080); no roles"
  project_roles = []
}

# -- Secrets: the service reads ONLY app and system (never the owner's) --------------------
resource "google_secret_manager_secret_iam_member" "assistants_app_accessor" {
  project   = var.project_id
  secret_id = module.secret_assistants_db_app.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = module.assistants_service_sa.member
}

resource "google_secret_manager_secret_iam_member" "assistants_system_accessor" {
  project   = var.project_id
  secret_id = module.secret_assistants_db_system.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = module.assistants_service_sa.member
}

# -- Deploy SA: reads the OWNER secret (runs the migration) and acts as the service SA --
resource "google_secret_manager_secret_iam_member" "assistants_owner_accessor_deploy" {
  project   = var.project_id
  secret_id = module.secret_assistants_db_owner.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.deploy_sa_email}"
}

resource "google_service_account_iam_member" "deploy_acts_as_service_sa" {
  service_account_id = module.assistants_service_sa.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${var.deploy_sa_email}"
}

# -- Knowledge bucket (decision 24): the service only READS. Additive; the bucket is not ours. --
resource "google_storage_bucket_iam_member" "assistants_knowledge_viewer" {
  bucket = "enlite-agentes-conhecimento"
  role   = "roles/storage.objectViewer"
  member = module.assistants_service_sa.member
}
