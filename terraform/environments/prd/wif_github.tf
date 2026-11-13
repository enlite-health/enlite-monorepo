# spec 077 FND-5: WIF do GitHub em prd, criado à mão (gcloud) e adotado pelo HCL por import (executa só no apply).
# Um dono só: esta lista gera a attribute_condition do provider E os bindings workloadIdentityUser da github-deploy-sa.
# Repo novo com deploy em prd = 1 linha aqui; a ordem importa (a condição viva é a junção nesta ordem).
locals {
  github_wif_repos = [
    "enlite-health/enlite-monorepo",
    "enlite-health/triage-service",
    "enlite-health/assistants-service",
    "enlite-health/attendance-service",
    "enlite-health/mobile-bff",
  ]
}

resource "google_iam_workload_identity_pool" "github" {
  project                   = var.project_id
  workload_identity_pool_id = "github-pool"
  display_name              = "GitHub Pool"
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-provider"
  display_name                       = "GitHub Provider"
  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.actor"      = "assertion.actor"
    "attribute.repository" = "assertion.repository"
  }
  attribute_condition = join(" || ", [for r in local.github_wif_repos : "(assertion.repository == '${r}' && assertion.ref == 'refs/heads/main')"])
  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account_iam_member" "github_deploy_wif" {
  for_each           = toset(local.github_wif_repos)
  service_account_id = module.sa_github_deploy.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${each.value}"
}

import {
  to = google_iam_workload_identity_pool.github
  id = "projects/enlite-prd/locations/global/workloadIdentityPools/github-pool"
}

import {
  to = google_iam_workload_identity_pool_provider.github
  id = "projects/enlite-prd/locations/global/workloadIdentityPools/github-pool/providers/github-provider"
}

import {
  for_each = toset(local.github_wif_repos)
  to       = google_service_account_iam_member.github_deploy_wif[each.value]
  id       = "projects/enlite-prd/serviceAccounts/github-deploy-sa@enlite-prd.iam.gserviceaccount.com roles/iam.workloadIdentityUser principalSet://iam.googleapis.com/projects/121472682203/locations/global/workloadIdentityPools/github-pool/attribute.repository/${each.value}"
}
