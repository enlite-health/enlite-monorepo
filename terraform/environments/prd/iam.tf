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
    "roles/firebaseauth.admin", # spec 050 R-41: papel estreito de Auth (11 permissões, nenhuma de Storage); R-42 tirou o firebase.admin
    "roles/pubsub.publisher",
    "roles/secretmanager.secretAccessor",
    "roles/serviceusage.apiKeysViewer",
    "roles/serviceusage.serviceUsageConsumer",
  ]
}

# spec 050 §18 R-40: o papel de assumir a PRÓPRIA conta (signBlob/signJwt) estava feito à mão no vivo. Entra no HCL por
# `import` (executa só no apply) antes de o papel de projeto sair (R-43).
resource "google_service_account_iam_member" "sa_enlite_functions_self_token_creator" {
  service_account_id = module.sa_enlite_functions.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = module.sa_enlite_functions.member
}

import {
  to = google_service_account_iam_member.sa_enlite_functions_self_token_creator
  id = "projects/enlite-prd/serviceAccounts/enlite-functions-sa@enlite-prd.iam.gserviceaccount.com roles/iam.serviceAccountTokenCreator serviceAccount:enlite-functions-sa@enlite-prd.iam.gserviceaccount.com"
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
    "roles/logging.configWriter", # spec 082: criar o sink ai_usage_to_bq (Editor não tem logging.sinks.create)
    "roles/resourcemanager.projectIamAdmin",
    "roles/secretmanager.admin",
  ]
}

import {
  to = module.sa_tf_admin.google_project_iam_member.roles["roles/logging.configWriter"]
  id = "enlite-prd roles/logging.configWriter serviceAccount:tf-admin@enlite-prd.iam.gserviceaccount.com"
}

# spec 077 D699: o tf-admin edita o provider WIF (attribute_condition do github-provider, wif_github.tf). O Editor do
# projeto da providers.get/list e NAO o update (403 no apply da D694). Papel proprio so com o update, no lugar do
# roles/iam.workloadIdentityPoolAdmin (create/delete/undelete de pool e provider, setIamPolicy do pool). Nome canonico
# (o do papel predefinido); o 403 cita o alias iam.workloadIdentityPoolProviders.update, que vale igual. O get segue
# vindo do Editor. Fora do project_roles do modulo: o for_each pede chave conhecida no plan, e o .name de papel novo
# so existe depois do apply.
resource "google_project_iam_custom_role" "wif_provider_update" {
  project     = var.project_id
  role_id     = "WifProviderUpdate"
  title       = "WIF: editar provider"
  description = "spec 077 D699: so o update do provider WIF; sem create, delete nem setIamPolicy"
  permissions = ["iam.googleapis.com/workloadIdentityPoolProviders.update"]
}

resource "google_project_iam_member" "tf_admin_wif_provider_update" {
  project = var.project_id
  role    = google_project_iam_custom_role.wif_provider_update.name
  member  = module.sa_tf_admin.member
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

# spec 077 FND-5: o deploy do attendance-service sobe o cloud-sql-proxy no runner como esta SA e conecta na enlite-ar-db.
# O cloudsql.client vivo dela é só na assistants-db (terraform/environments/assistants/iam.tf, "only-assistants-db").
resource "google_project_iam_member" "github_deploy_cloudsql_client_ar_db" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = module.sa_github_deploy.member

  condition {
    title       = "only-enlite-ar-db"
    description = "spec 077: cloudsql.client so na enlite-ar-db (migrations do attendance-service)"
    expression  = "resource.type == \"sqladmin.googleapis.com/Instance\" && resource.name == \"projects/${var.project_id}/instances/${module.sql_enlite_ar_db.name}\""
  }
}
