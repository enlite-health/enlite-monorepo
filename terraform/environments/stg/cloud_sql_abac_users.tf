# Usuários de LOGIN do ABAC por país (abac-pais-fase1, task 2.2 / lex C4)
#
# As roles de GRUPO `app_runtime` e `app_system` nascem na migration 269 e são
# NOLOGIN — elas carregam as permissões, não a conexão. Quem conecta são estes
# dois usuários, e é a troca da connection do app para `enlite_runtime` (atrás de
# COUNTRY_RLS_ENABLED) que liga o isolamento de fato: `enlite_app` é OWNER das
# tabelas e, sem FORCE, o owner ignora as policies.
#
#   enlite_runtime → caminho de request do staff; sujeito à RLS de país.
#   enlite_system  → crons, webhooks, filas e capabilities MCP; o atalho de
#                    sistema da policy exige MEMBRO de app_system + contexto
#                    `app.system_context` explícito.
#
# ⚠️ A SENHA NÃO PASSA POR AQUI, DE PROPÓSITO. Hoje nenhum valor de secret vive
# no state deste repo (o módulo `secret` cria só o CONTAINER; os valores entram
# à mão). `random_password` + `google_secret_manager_secret_version` seriam mais
# cômodos e quebrariam essa invariante: a senha do banco passaria a ser legível
# por quem lê `gs://enlite-tf-state`, sem o IAM por-secret nem o audit log do
# Secret Manager. Então: usuário CRIADO fora com senha aleatória, senha
# publicada no Secret Manager, e o recurso IMPORTADO para cá no mesmo bloco de
# trabalho (D106 — o HCL reflete a realidade, nunca o contrário).
#
# Runbook com os comandos exatos (criar → publicar → importar → verificar):
#   worker-functions/docs/runbook-abac-login-users.md
#
# Alvo de longo prazo, fora desta change: autenticação IAM do Cloud SQL
# (`type = "CLOUD_IAM_SERVICE_ACCOUNT"`), que elimina a senha inteira. Exige
# flag na instância, provider 6.x e a aplicação trocando a senha por um token
# OAuth — escopo próprio, depois do rollout do ABAC.

locals {
  abac_login_users = {
    enlite_runtime = "app_runtime"
    enlite_system  = "app_system"
  }
}

resource "google_sql_user" "abac" {
  for_each = local.abac_login_users

  project  = var.project_id
  instance = "enlite-ar-db"
  name     = each.key

  # Placeholder: o valor real nunca chega ao state (ver bloco acima). O
  # `ignore_changes` impede que um `apply` sobrescreva a senha viva com isto —
  # sem ele, o primeiro apply depois do import derrubaria a conexão do app.
  password = "MANAGED_OUTSIDE_TERRAFORM"

  lifecycle {
    ignore_changes = [password]
  }
}

# Containers das senhas (valores publicados pelo runbook, como todo secret aqui).
module "secret_enlite_runtime_db_password" {
  source                = "../../modules/secret"
  project_id            = var.project_id
  secret_id             = "enlite-runtime-db-password"
  replication_locations = ["southamerica-west1"]
}

module "secret_enlite_system_db_password" {
  source                = "../../modules/secret"
  project_id            = var.project_id
  secret_id             = "enlite-system-db-password"
  replication_locations = ["southamerica-west1"]
}
