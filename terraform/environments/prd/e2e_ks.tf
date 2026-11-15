# spec 077 FND-13 (iv): identidade do workflow e2e-ks.yml do enlite-app, que alterna KILL_SWITCH e MIN_VERSION_ANDROID
# do mobile-bff-ks (scripts/ks-alternar.sh = gcloud run services update). NAO e a github-deploy-sa (run.admin no projeto
# inteiro, DT-09). Minimo pela doc do Cloud Run (docs.cloud.google.com/run/docs/deploying, "Required roles"):
# run.developer NO servico, serviceAccountUser NA identidade do servico (mobile-bff-ks-sa, D671) e artifactregistry.reader
# NO repositorio da imagem. D680: no lugar do run.developer (traz run.services.delete), o papel proprio KsAlternar, so
# com o que o update chama. Nenhum papel no projeto. Nasce no HCL: nada criado por gcloud, nada a importar.
# D671: o mobile-bff-ks roda com identidade PROPRIA (mobile-bff-ks-sa, abaixo), nunca com a mobile-bff-sa: update no
# servico + actAs deixam quem alterna o ks rodar codigo como a identidade do servico, entao o actAs cai so nela.
# O mobile-bff-ks e deployado pelo workflow do mobile-bff (Cloud Run de prd fora do HCL, attendance_services.tf:5-7):
# o binding no servico mora aqui, como o bff_invokes_attendance.
# Quem entra: so o workflow_ref de local.github_wif_workflows (wif_github.tf), pelo provider github-provider.

# Identidade de runtime do mobile-bff-ks (D671). O ks e a MESMA imagem do mobile-bff: na base (KILL_SWITCH=false) responde
# /v1/config e /v1/me como o BFF. Minimo medido (14/11) para isso: firebaseauth.viewer (checkRevoked, P10) e run.invoker no
# attendance-service (o /v1/config e o /v1/me chamam o attendance com ID token do Google). Sem segredo: o deploy do ks roda
# com --clear-secrets (GOOGLE_MAPS_API_KEY e opcional, config.ts do mobile-bff). Quem a usa: o job deploy-ks-prd do
# mobile-bff (--service-account) e o actAs da e2e-ks-sa.
module "sa_mobile_bff_ks" {
  source       = "../../modules/service-account"
  project_id   = var.project_id
  account_id   = "mobile-bff-ks-sa"
  display_name = "Mobile BFF kill-switch (mobile-bff-ks)"
  project_roles = [
    "roles/firebaseauth.viewer", # checkRevoked (P10) le o usuario no Firebase Auth
  ]
}

resource "google_cloud_run_v2_service_iam_member" "bff_ks_invokes_attendance" {
  project  = var.project_id
  location = "southamerica-west1"
  name     = "attendance-service"
  role     = "roles/run.invoker"
  member   = module.sa_mobile_bff_ks.member
}

module "sa_e2e_ks" {
  source       = "../../modules/service-account"
  project_id   = var.project_id
  account_id   = "e2e-ks-sa"
  display_name = "E2E kill-switch (enlite-app e2e-ks.yml)"
}

# D680: so o que o `gcloud run services update` do scripts/ks-alternar.sh chama (gcloud 560,
# surface/run/services/update.py e command_lib/run/serverless_operations.py): GET do servico, LIST/GET de revisao (a
# imagem e fixada por digest, _EnsureImageDigest) e o PUT (replaceService). Sem delete, sem create, sem setIamPolicy.
# As 4 sao concediveis no recurso do servico (gcloud iam list-testable-permissions do mobile-bff-ks).
resource "google_project_iam_custom_role" "ks_alternar" {
  project     = var.project_id
  role_id     = "KsAlternar"
  title       = "Kill switch: alternar o mobile-bff-ks"
  description = "spec 077 D680: get/update do servico e leitura de revisao; sem delete"
  permissions = ["run.revisions.get", "run.revisions.list", "run.services.get", "run.services.update"]
}

resource "google_cloud_run_v2_service_iam_member" "e2e_ks_alternar" {
  project  = var.project_id
  location = "southamerica-west1"
  name     = "mobile-bff-ks"
  role     = google_project_iam_custom_role.ks_alternar.name
  member   = module.sa_e2e_ks.member
}

resource "google_service_account_iam_member" "e2e_ks_actas_ks" {
  service_account_id = module.sa_mobile_bff_ks.name
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
      condition     = length(setintersection(toset(local.github_wif_repos), toset(keys(local.github_wif_workflows)))) == 0 && !contains(local.github_wif_repos, "enlite-health/enlite-app")
      error_message = "repo de github_wif_workflows nao pode estar em github_wif_repos (daria a github-deploy-sa; DT-09)"
    }
  }
}
