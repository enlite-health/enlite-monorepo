# DEDICATED instance for the assistants (spec 080). Molde: luz-store/cloud_sql_luz_knowledge.tf.
# Only user created via terraform: the owner. assistants_app and assistants_system are BORN in migration 001
# (SQL) -- a user created through the Cloud SQL API lands in cloudsqlsuperuser. Their passwords
# are set by the runner (set-password) from the secrets below.

module "sql_assistants" {
  source     = "../../modules/cloud-sql"
  project_id = var.project_id
  name       = "assistants-db"
  region     = var.region
  zone       = "${var.region}-b"
  tier       = "db-f1-micro"

  database_version  = "POSTGRES_16"
  disk_size_gb      = 10
  backup_start_time = "14:00"

  # NO authorized_networks: connection only through the Cloud SQL connector (IAM cloudsql.client).
  authorized_networks = []
}

resource "google_sql_database" "assistants" {
  project  = var.project_id
  instance = module.sql_assistants.name
  name     = "assistants"
}

# -- Passwords (special=false: simpler connection string) --------------------
resource "random_password" "assistants_owner" {
  length  = 32
  special = false
}

resource "random_password" "assistants_app" {
  length  = 32
  special = false
}

resource "random_password" "assistants_system" {
  length  = 32
  special = false
}

# -- Only user created by terraform: the owner (only runs migrations) -----------
resource "google_sql_user" "assistants_owner" {
  project  = var.project_id
  instance = module.sql_assistants.name
  name     = "assistants_owner"
  password = random_password.assistants_owner.result
}

# -- Secrets: owner, app, system ------------------------------------------------
module "secret_assistants_db_owner" {
  source                = "../../modules/secret"
  project_id            = var.project_id
  secret_id             = "assistants-db-owner-password"
  replication_locations = [var.region]
}

resource "google_secret_manager_secret_version" "assistants_db_owner_v1" {
  secret      = module.secret_assistants_db_owner.id
  secret_data = random_password.assistants_owner.result
}

module "secret_assistants_db_app" {
  source                = "../../modules/secret"
  project_id            = var.project_id
  secret_id             = "assistants-db-app-password"
  replication_locations = [var.region]
}

resource "google_secret_manager_secret_version" "assistants_db_app_v1" {
  secret      = module.secret_assistants_db_app.id
  secret_data = random_password.assistants_app.result
}

module "secret_assistants_db_system" {
  source                = "../../modules/secret"
  project_id            = var.project_id
  secret_id             = "assistants-db-system-password"
  replication_locations = [var.region]
}

resource "google_secret_manager_secret_version" "assistants_db_system_v1" {
  secret      = module.secret_assistants_db_system.id
  secret_data = random_password.assistants_system.result
}
