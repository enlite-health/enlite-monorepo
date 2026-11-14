# spec 077 FND-13 (iv): identidade do workflow e2e-ks.yml do enlite-app, que alterna KILL_SWITCH e MIN_VERSION_ANDROID
# do mobile-bff-ks (scripts/ks-alternar.sh = gcloud run services update). NAO e a github-deploy-sa (run.admin no projeto
# inteiro, DT-09). Minimo pela doc do Cloud Run (docs.cloud.google.com/run/docs/deploying, "Required roles"):
# run.developer NO servico, serviceAccountUser NA identidade do servico (mobile-bff-sa) e artifactregistry.reader NO
# repositorio da imagem. Nenhum papel no projeto. Nasce no HCL: nada criado por gcloud, nada a importar.
# O mobile-bff-ks e deployado pelo workflow do mobile-bff (Cloud Run de prd fora do HCL, attendance_services.tf:5-7):
# o binding no servico mora aqui, como o bff_invokes_attendance.
# Quem entra: so o workflow_ref de local.github_wif_workflows (wif_github.tf), pelo provider github-provider.

module "sa_e2e_ks" {
  source       = "../../modules/service-account"
  project_id   = var.project_id
  account_id   = "e2e-ks-sa"
  display_name = "E2E kill-switch (enlite-app e2e-ks.yml)"
}

resource "google_cloud_run_v2_service_iam_member" "e2e_ks_developer" {
  project  = var.project_id
  location = "southamerica-west1"
  name     = "mobile-bff-ks"
  role     = "roles/run.developer"
  member   = module.sa_e2e_ks.member
}

resource "google_service_account_iam_member" "e2e_ks_actas_bff" {
  service_account_id = module.sa_mobile_bff.name
  role               = "roles/iam.serviceAccountUser"
  member             = module.sa_e2e_ks.member
}

resource "google_artifact_registry_repository_iam_member" "e2e_ks_le_imagem" {
  project    = var.project_id
  location   = "southamerica-west1"
  repository = module.ar_mobile_bff.name
  role       = "roles/artifactregistry.reader"
  member     = module.sa_e2e_ks.member
}

# O provider so aceita deste repo o workflow_ref exato (clausula de github_wif_workflows); o binding e por repo.
resource "google_service_account_iam_member" "e2e_ks_wif" {
  service_account_id = module.sa_e2e_ks.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/enlite-health/enlite-app"

  lifecycle {
    # DT-09: repo com SA propria nunca entra em github_wif_repos (la a condicao aceita qualquer workflow da main e o
    # repo ganha a github-deploy-sa). O plan para aqui se alguem o fizer.
    precondition {
      condition     = length(setintersection(toset(local.github_wif_repos), toset(keys(local.github_wif_workflows)))) == 0
      error_message = "repo de github_wif_workflows nao pode estar em github_wif_repos (daria a github-deploy-sa; DT-09)"
    }
  }
}
