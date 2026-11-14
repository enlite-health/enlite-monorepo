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
  # Repos SEM a github-deploy-sa: a condicao aceita deles SO o workflow_ref exato (repo => workflow_ref), cada um com a
  # sua SA de minimo. Nunca repetir aqui um repo de github_wif_repos (precondition do e2e_ks_wif em e2e_ks.tf; DT-09).
  # Vem depois das clausulas de deploy: o prefixo da condicao viva nao muda.
  github_wif_workflows = {
    "enlite-health/enlite-app" = "enlite-health/enlite-app/.github/workflows/e2e-ks.yml@refs/heads/main"
  }
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
  attribute_condition = join(" || ", concat(
    [for r in local.github_wif_repos : "(assertion.repository == '${r}' && assertion.ref == 'refs/heads/main')"],
    [for r, w in local.github_wif_workflows : "(assertion.repository == '${r}' && assertion.ref == 'refs/heads/main' && assertion.workflow_ref == '${w}')"],
  ))
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
