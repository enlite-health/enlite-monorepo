module "sql_enlite_ar_db" {
  source     = "../../modules/cloud-sql"
  project_id = var.project_id
  name       = "enlite-ar-db"
  region     = "southamerica-west1"
  zone       = "southamerica-west1-b"
  tier       = "db-custom-1-3840"

  authorized_networks = [{
    name  = ""
    value = "0.0.0.0/0"
  }]
}

module "sql_enlite_n8n_db_ar" {
  source     = "../../modules/cloud-sql"
  project_id = var.project_id
  name       = "enlite-n8n-db-ar"
  region     = "southamerica-west1"
  zone       = "southamerica-west1-a"
  tier       = "db-f1-micro"

  disk_size_gb      = 10
  backup_start_time = "13:00"

  require_ssl = false
  ssl_mode    = "ALLOW_UNENCRYPTED_AND_ENCRYPTED"
}

# Cloud SQL pra memória persistente da Luz (triage-service).
# Postgres 16 + pgvector pra semantic search.
# Region southamerica-west1 (mesma do triage Cloud Run, intra-region <5ms).
# Volume previsto: ~500 conv/dia × 3 msgs = ~45k embeddings/mês.
# db-f1-micro aguenta até ~5k conv/dia sem upgrade.
# Detalhes: triage-service/docs/MEMORY_DESIGN.md
module "sql_triage_memory" {
  source     = "../../modules/cloud-sql"
  project_id = var.project_id
  name       = "triage-memory"
  region     = "southamerica-west1"
  zone       = "southamerica-west1-b"
  tier       = "db-f1-micro"

  database_version = "POSTGRES_16"
  disk_size_gb     = 10

  backup_start_time = "14:00"

  # Mesmo padrão do enlite-ar-db: public IP + SSL com cert client.
  # TODO fase 2: migrar pra Private IP + Cloud SQL Auth Proxy (sidecar Cloud Run).
  authorized_networks = [{
    name  = ""
    value = "0.0.0.0/0"
  }]
}

# Database `triage_memory` dentro da instance.
resource "google_sql_database" "triage_memory_db" {
  project  = var.project_id
  instance = module.sql_triage_memory.name
  name     = "triage_memory"
}

# User `triage` pra conexão da app.
# Password gerada randomicamente e armazenada em Secret Manager.
resource "random_password" "triage_memory_db_password" {
  length  = 32
  special = false # facilita URL connection string
}

resource "google_sql_user" "triage_memory_user" {
  project  = var.project_id
  instance = module.sql_triage_memory.name
  name     = "triage"
  password = random_password.triage_memory_db_password.result
}

# Permite triage-service-sa (existente, criada fora do TF) conectar
# via Cloud SQL connector. Bind direto pra SA conhecida.
resource "google_project_iam_member" "triage_service_sa_cloudsql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:triage-service-sa@${var.project_id}.iam.gserviceaccount.com"
}
