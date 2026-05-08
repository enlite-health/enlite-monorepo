# Estrutura espelhada de prd. Valores são populados separadamente
# (manual ou via pipeline de bootstrap stg).

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

module "secret_postgres_root_password" {
  source     = "../../modules/secret"
  project_id = var.project_id
  secret_id  = "enlite-postgres-root-password"
}

module "secrets_automatic" {
  source     = "../../modules/secret"
  for_each   = toset(local.automatic_secrets)
  project_id = var.project_id
  secret_id  = each.value
}
