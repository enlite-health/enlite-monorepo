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

  # authorized_networks fica no default do módulo: [] — NENHUMA rede autorizada.
  #
  # Mesma armadilha que o #202 desarmou em prd, encontrada aqui em 13/08/2026 ao
  # rodar `plan` para importar os usuários do ABAC: o código pedia
  # [{ name = "", value = "0.0.0.0/0" }] e a instância viva NUNCA teve isso
  # (`gcloud sql instances describe enlite-ar-db --project=enlite-stg` devolve
  # ipConfiguration SEM authorizedNetworks). O `plan` pedia "update in-place"
  # ADICIONANDO a regra — um apply feito para qualquer outra coisa abriria o
  # Postgres de staging para a internet inteira.
  #
  # Staging não é "só teste": recebeu as 33 migrations de backlog e tem dado de
  # paciente carregado. O acesso legítimo é por cloud-sql-proxy, como em prd.

  # Stg dispensável: dropar com TF é OK (não tem dado real ainda)
  deletion_protection = false
}
