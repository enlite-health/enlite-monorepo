# Instancia DEDICADA das gestoras (spec 080). Molde: luz-store/cloud_sql_luz_knowledge.tf.
# Unico usuario via terraform: o dono. gestoras_app e gestoras_sistema NASCEM na migration 001
# (SQL) -- usuario criado pela API do Cloud SQL entra em cloudsqlsuperuser. Suas senhas
# sao definidas pelo runner (set-password) a partir dos secrets abaixo.

module "sql_gestoras" {
  source     = "../../modules/cloud-sql"
  project_id = var.project_id
  name       = "gestoras-db"
  region     = var.region
  zone       = "${var.region}-b"
  tier       = "db-f1-micro"

  database_version  = "POSTGRES_16"
  disk_size_gb      = 10
  backup_start_time = "14:00"

  # SEM authorized_networks: conexao so pelo Cloud SQL connector (IAM cloudsql.client).
  authorized_networks = []
}

resource "google_sql_database" "gestoras" {
  project  = var.project_id
  instance = module.sql_gestoras.name
  name     = "gestoras"
}

# -- Senhas (special=false: connection string mais simples) --------------------
resource "random_password" "gestoras_owner" {
  length  = 32
  special = false
}

resource "random_password" "gestoras_app" {
  length  = 32
  special = false
}

resource "random_password" "gestoras_sistema" {
  length  = 32
  special = false
}

# -- Unico usuario criado pelo terraform: o dono (so roda migration) -----------
resource "google_sql_user" "gestoras_owner" {
  project  = var.project_id
  instance = module.sql_gestoras.name
  name     = "gestoras_owner"
  password = random_password.gestoras_owner.result
}

# -- Secrets: dono, app, sistema ------------------------------------------------
module "secret_gestoras_db_owner" {
  source                = "../../modules/secret"
  project_id            = var.project_id
  secret_id             = "gestoras-db-owner-password"
  replication_locations = [var.region]
}

resource "google_secret_manager_secret_version" "gestoras_db_owner_v1" {
  secret      = module.secret_gestoras_db_owner.id
  secret_data = random_password.gestoras_owner.result
}

module "secret_gestoras_db_app" {
  source                = "../../modules/secret"
  project_id            = var.project_id
  secret_id             = "gestoras-db-app-password"
  replication_locations = [var.region]
}

resource "google_secret_manager_secret_version" "gestoras_db_app_v1" {
  secret      = module.secret_gestoras_db_app.id
  secret_data = random_password.gestoras_app.result
}

module "secret_gestoras_db_sistema" {
  source                = "../../modules/secret"
  project_id            = var.project_id
  secret_id             = "gestoras-db-sistema-password"
  replication_locations = [var.region]
}

resource "google_secret_manager_secret_version" "gestoras_db_sistema_v1" {
  secret      = module.secret_gestoras_db_sistema.id
  secret_data = random_password.gestoras_sistema.result
}
