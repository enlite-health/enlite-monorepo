# Custom roles do projeto (paridade com prd)
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

# tf-admin NÃO é declarada em stg — a SA vive em enlite-prd e tem bindings
# cross-project pra atuar em ambos os projetos. Os bindings em stg são
# gerenciados em prd/iam.tf via google_project_iam_member com project=enlite-stg.
