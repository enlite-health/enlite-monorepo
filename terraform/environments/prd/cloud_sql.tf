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
