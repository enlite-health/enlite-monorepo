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

module "secret_triage_memory_db_password" {
  source                = "../../modules/secret"
  project_id            = var.project_id
  secret_id             = "triage-memory-db-password"
  replication_locations = ["southamerica-west1"]
}

# Versão inicial do secret com a senha randômica gerada pelo TF.
# Rotações futuras serão manuais via `gcloud secrets versions add`.
resource "google_secret_manager_secret_version" "triage_memory_db_password_v1" {
  secret      = module.secret_triage_memory_db_password.id
  secret_data = random_password.triage_memory_db_password.result
}

# Permite triage-service-sa ler o secret da senha (Cloud Run lê em runtime).
resource "google_secret_manager_secret_iam_member" "triage_memory_db_password_accessor" {
  project   = var.project_id
  secret_id = module.secret_triage_memory_db_password.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:triage-service-sa@${var.project_id}.iam.gserviceaccount.com"
}

module "secrets_automatic" {
  source     = "../../modules/secret"
  for_each   = toset(local.automatic_secrets)
  project_id = var.project_id
  secret_id  = each.value
}
