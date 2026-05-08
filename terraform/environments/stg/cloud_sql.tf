# Tier reduzido em stg para economia (~$10/mês cada)
# Decisão: stg testa lógica, não performance — db-f1-micro basta.

module "sql_enlite_ar_db" {
  source     = "../../modules/cloud-sql"
  project_id = var.project_id
  name       = "enlite-ar-db"
  region     = "southamerica-west1"
  zone       = "southamerica-west1-b"
  tier       = "db-f1-micro"

  disk_size_gb = 10

  authorized_networks = [{
    name  = ""
    value = "0.0.0.0/0"
  }]

  # Stg dispensável: dropar com TF é OK (não tem dado real ainda)
  deletion_protection = false
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

  deletion_protection = false
}
