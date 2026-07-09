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
