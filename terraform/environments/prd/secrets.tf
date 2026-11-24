# Os valores dos secrets NÃO ficam no Terraform. O TF cria a estrutura;
# valores são populados via gcloud secrets versions add (manual ou CI/CD).

locals {
  automatic_secrets = [
    "groq-api-key",
    "internal-token-secret",
    "sendgrid-api-key",
    "short-io-api-key",
    "short-io-domain",
    "talentum-api-email",
    "talentum-api-password",
    "twilio-auth-token",
  ]
}

module "secret_enlite_ar_db_password" {
  source                = "../../modules/secret"
  project_id            = var.project_id
  secret_id             = "enlite-ar-db-password"
  replication_locations = ["southamerica-west1"]
}

module "secrets_automatic" {
  source     = "../../modules/secret"
  for_each   = toset(local.automatic_secrets)
  project_id = var.project_id
  secret_id  = each.value
}

# Smoke test pós-deploy: a SA de deploy (GitHub Actions) lê o internal-token-secret
# para chamar /api/internal/vertex-health com o header x-internal-secret. Acesso
# limitado a ESTE secret (não project-wide).
resource "google_secret_manager_secret_iam_member" "github_deploy_internal_token" {
  project   = var.project_id
  secret_id = module.secrets_automatic["internal-token-secret"].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = module.sa_github_deploy.member
}

# DP-04: chave de servidor do Google Maps ("Maps Server prd", a mesma do worker-functions)
# para o mobile-bff, montada como GOOGLE_MAPS_API_KEY por --set-secrets no deploy
# (só o mobile-bff, com a mobile-bff-sa; o mobile-bff-ks roda com a mobile-bff-ks-sa e sem este secret, D671). Como os demais: o TF cria só a
# estrutura; a versão (o valor) entra por gcloud secrets versions add, nunca pelo HCL/state.
module "secret_google_maps_server_api_key" {
  source     = "../../modules/secret"
  project_id = var.project_id
  secret_id  = "google-maps-server-api-key"
}

resource "google_secret_manager_secret_iam_member" "mobile_bff_google_maps_server_key" {
  project   = var.project_id
  secret_id = module.secret_google_maps_server_api_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = module.sa_mobile_bff.member
}

# FR-95/DP-23 (spec 077): código de OTP de teste (E2E do cadastro). Só vale para ficha `is_test` E token
# `@enlite.test`; montado como E2E_OTP_CODE no worker-functions (backend-prd.yml). Sem binding próprio: a
# enlite-functions-sa já lê secrets no projeto (iam.tf, roles/secretmanager.secretAccessor). Como os demais: o TF
# cria só a estrutura; a versão (o valor) entra por gcloud secrets versions add, nunca pelo HCL/state.
module "secret_e2e_otp_code_prd" {
  source     = "../../modules/secret"
  project_id = var.project_id
  secret_id  = "e2e-otp-code-prd"
}

# spec 077, D758 (PR-INF-46): pepper do HMAC do OTP próprio, montado como OTP_HMAC_PEPPER no worker-functions
# (backend-prd.yml). Replicação automática. O TF cria só a estrutura; a VERSÃO (o valor) NÃO entra no HCL, para o valor não
# ir ao state: `python3 -I -c 'import secrets;print(secrets.token_hex(32),end="")' | gcloud secrets versions add otp-hmac-pepper-prd --data-file=- --project enlite-prd`
# (rodar depois do apply). O binding por secret é explícito apesar de a enlite-functions-sa já ter secretAccessor no projeto (iam.tf):
# deixa registrado quem lê ESTE secret.
module "secret_otp_hmac_pepper_prd" {
  source     = "../../modules/secret"
  project_id = var.project_id
  secret_id  = "otp-hmac-pepper-prd"
}

resource "google_secret_manager_secret_iam_member" "worker_functions_otp_hmac_pepper" {
  project   = var.project_id
  secret_id = module.secret_otp_hmac_pepper_prd.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = module.sa_enlite_functions.member
}
