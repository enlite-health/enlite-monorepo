# Os valores dos secrets NÃO ficam no Terraform. O TF cria a estrutura;
# valores são populados via gcloud secrets versions add (manual ou CI/CD).

locals {
  automatic_secrets = [
    "groq-api-key",
    "internal-token-secret",
    "n8n-basic-auth-password",
    "n8n-db-password",
    "n8n-encryption-key",
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
