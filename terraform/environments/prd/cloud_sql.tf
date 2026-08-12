module "sql_enlite_ar_db" {
  source     = "../../modules/cloud-sql"
  project_id = var.project_id
  name       = "enlite-ar-db"
  region     = "southamerica-west1"
  zone       = "southamerica-west1-b"
  tier       = "db-custom-1-3840"

  # authorized_networks fica no default do módulo: [] — NENHUMA rede autorizada.
  #
  # Antes daqui saía [{ name = "", value = "0.0.0.0/0" }], ou seja, a internet
  # inteira. A instância viva NUNCA teve isso (verificado em 11/08/2026:
  # `gcloud sql instances describe enlite-ar-db` devolve authorizedNetworks vazio),
  # então o código estava em oposição à realidade e o `plan` pedia
  # "update in-place" ADICIONANDO a regra. Um `apply` feito para qualquer outra
  # coisa abriria o Postgres de produção — com PHI sob Ley 25.326 — sem que
  # ninguém tivesse errado: bastava usar a ferramenta normalmente.
  #
  # O acesso legítimo não passa por rede autorizada: aplicação usa o socket
  # /cloudsql (Cloud Run) e operação usa cloud-sql-proxy. Se algum dia for
  # preciso liberar um IP, liberar AQUELE IP — nunca 0.0.0.0/0.
}
