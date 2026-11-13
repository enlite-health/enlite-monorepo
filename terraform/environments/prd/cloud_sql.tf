module "sql_enlite_ar_db" {
  source     = "../../modules/cloud-sql"
  project_id = var.project_id
  name       = "enlite-ar-db"
  region     = "southamerica-west1"
  zone       = "southamerica-west1-b"
  tier       = "db-custom-1-3840"

  user_labels = { service = "enlite-ar-db", setor = "plataforma" }

  # spec 077 FND-6: cloudsql.iam_authentication não reinicia (doc de flags, Restart Required? = No). Apply pós-merge com tf-admin (D664).
  # P8 (29/10): a role attendance_runtime autentica por IAM; o usuário IAM está em attendance_services.tf (T294).
  database_flags = [{ name = "cloudsql.iam_authentication", value = "on" }]

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
