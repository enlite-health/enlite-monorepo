# Custom roles do projeto
resource "google_project_iam_custom_role" "api_keys_lookup" {
  project     = var.project_id
  role_id     = "ApiKeysLookup"
  title       = "API Keys Lookup"
  permissions = ["apikeys.keys.lookup"]
  stage       = "GA"
}

module "sa_enlite_functions" {
  source       = "../../modules/service-account"
  project_id   = var.project_id
  account_id   = "enlite-functions-sa"
  display_name = "Enlite Functions Service Account"
  project_roles = [
    google_project_iam_custom_role.api_keys_lookup.name,
    "roles/aiplatform.user", # Vertex AI (geração de descrição + prescreening via ADC)
    "roles/cloudsql.client",
    "roles/cloudtasks.enqueuer",
    "roles/firebase.admin",
    "roles/iam.serviceAccountTokenCreator",
    "roles/pubsub.publisher",
    "roles/secretmanager.secretAccessor",
    "roles/serviceusage.apiKeysViewer",
    "roles/serviceusage.serviceUsageConsumer",
  ]
}

module "sa_pubsub_invoker" {
  source       = "../../modules/service-account"
  project_id   = var.project_id
  account_id   = "pubsub-invoker"
  display_name = "Pub/Sub Push Invoker"
}

module "sa_github_deploy" {
  source       = "../../modules/service-account"
  project_id   = var.project_id
  account_id   = "github-deploy-sa"
  display_name = "GitHub Actions Deploy"
  project_roles = [
    "roles/artifactregistry.repoAdmin",
    "roles/artifactregistry.writer",
    "roles/iam.serviceAccountUser",
    "roles/run.admin",
  ]
}

module "sa_n8n_integration" {
  source       = "../../modules/service-account"
  project_id   = var.project_id
  account_id   = "n8n-integration-identity"
  display_name = "N8N Integration"
  description  = "This account service is to n8n and APIs comunicate each other"
  project_roles = [
    "roles/iap.httpsResourceAccessor",
    "roles/run.servicesInvoker",
    "roles/serviceusage.apiKeysViewer",
  ]
}

module "sa_tf_admin" {
  source       = "../../modules/service-account"
  project_id   = var.project_id
  account_id   = "tf-admin"
  display_name = "Terraform Admin"
  description  = "Service account used by Terraform to manage infra in enlite-prd and enlite-stg"
  project_roles = [
    "roles/cloudsql.admin",
    "roles/editor",
    "roles/iam.roleAdmin",
    "roles/iam.securityAdmin",
    "roles/resourcemanager.projectIamAdmin",
    "roles/secretmanager.admin",
  ]
}

# Bindings cross-project: a SA tf-admin vive em enlite-prd mas precisa atuar
# em enlite-stg também. As bindings em enlite-stg são gerenciadas aqui usando
# o mesmo provider (que opera em var.project_id == enlite-prd) com
# project="enlite-stg" explícito.
locals {
  tf_admin_stg_roles = [
    "roles/cloudsql.admin",
    "roles/editor",
    "roles/firebase.admin",
    "roles/iam.roleAdmin",
    "roles/iam.securityAdmin",
    "roles/resourcemanager.projectIamAdmin",
    "roles/secretmanager.admin",
  ]
}

resource "google_project_iam_member" "tf_admin_stg" {
  for_each = toset(local.tf_admin_stg_roles)
  project  = "enlite-stg"
  role     = each.value
  member   = module.sa_tf_admin.member
}
