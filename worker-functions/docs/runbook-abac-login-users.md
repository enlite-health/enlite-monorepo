# Runbook — usuários de LOGIN do ABAC por país (`enlite_runtime` / `enlite_system`)

Change `abac-pais-fase1`, task 2.2 (condição C4 do `lex`). Executar **por ambiente**,
`stg` primeiro. Nada aqui liga o isolamento: a virada é a troca da connection do app,
atrás de `COUNTRY_RLS_ENABLED` (tasks 4.1 e 4.3).

## Por que existe

As roles `app_runtime` e `app_system` (migration 269) são **NOLOGIN**: carregam
permissão, não conexão. Quem conecta são os dois usuários abaixo. Isso importa porque
`enlite_app` é **OWNER** das tabelas e, sem `FORCE`, o owner **ignora** as policies —
enquanto o app conectar como ele, a RLS de país não vale para nada.

| usuário | grupo | serve | sob RLS |
|---|---|---|---|
| `enlite_runtime` | `app_runtime` | request de staff | **sim**, confinado ao país |
| `enlite_system` | `app_system` | crons, webhooks, filas, MCP | atalho de sistema, com `app.system_context` explícito |

## Por que a senha não está no terraform

Hoje **nenhum valor de secret vive no state** deste repo — o módulo `secret` cria só o
container. `random_password` + `google_secret_manager_secret_version` quebraria isso: a
senha do banco passaria a ser legível por quem lê `gs://enlite-tf-state`, sem o IAM
por-secret nem o audit log do Secret Manager. Então a senha nasce fora, vai para o Secret
Manager, e o **usuário é importado** para o HCL no mesmo bloco de trabalho (D106).

## Passo a passo (repetir por ambiente)

Variáveis do ambiente — trocar `enlite-stg` por `enlite-prd` na vez de prod:

```bash
PROJECT=enlite-stg
INSTANCE=enlite-ar-db
```

### 1. Conferir que enlite_app pode conceder membership

O GRANT sai da migration 273, rodando como `enlite_app`. Em Postgres 15 quem tem
`CREATEROLE` pode conceder qualquer role não-superuser — e ele tem, senão a 269 não teria
criado as roles. Conferir antes de seguir:

```bash
# via cloud-sql-proxy, conectado no banco do ambiente
psql -c "SELECT rolcreaterole FROM pg_roles WHERE rolname = 'enlite_app';"   # espera: t
psql -c "SELECT rolname, rolcanlogin, rolbypassrls FROM pg_roles WHERE rolname IN ('app_runtime','app_system');"
# espera: as duas com rolcanlogin=f e rolbypassrls=f
```

### 2. Gerar as senhas e criar os usuários

```bash
for U in enlite_runtime enlite_system; do
  PW=$(openssl rand -base64 32 | tr -d '/+=' | head -c 32)
  gcloud sql users create "$U" --instance="$INSTANCE" --project="$PROJECT" --password="$PW"
  printf '%s' "$PW" | gcloud secrets versions add "${U//_/-}-db-password" \
    --project="$PROJECT" --data-file=-
  unset PW
done
```

Os containers `enlite-runtime-db-password` e `enlite-system-db-password` já existem no
HCL (`cloud_sql_abac_users.tf`) — se ainda não foram aplicados, criar antes com
`gcloud secrets create` **e importar**, na mesma disciplina.

### 3. Conceder a membership — **passo AUTORITATIVO deste runbook**

```bash
psql -f scripts/assert-abac-membership.sql
```

O script CONCEDE (idempotente), VERIFICA em `pg_auth_members` e **falha com exceção** se a
membership não estiver de pé. Re-executável à vontade. Saída esperada, no fim:

```
NOTICE:  [abac] membership verificada em pg_auth_members — enlite_runtime→app_runtime e enlite_system→app_system OK

  login_user    | group_role  | rolcanlogin | rolbypassrls
----------------+-------------+-------------+--------------
 enlite_runtime | app_runtime | t           | f
 enlite_system  | app_system  | t           | f
```

⚠️ **Não é a migration 273 que garante isto neste ambiente.** A 273 só concede a quem já
existe no momento em que ela roda — e aqui os usuários nasceram no passo 2, DEPOIS do
deploy. Nesse caminho ela passa sem conceder (com `WARNING: [abac] CONCESSÃO PENDENTE` no
log de deploy), o runner a registra em `schema_migrations` por não ter havido erro, e ela
**não volta a rodar sozinha**. Por isso o passo autoritativo é este script.

⚠️ **NÃO inserir nada em `schema_migrations` à mão.** O runner já gravou a linha da 273 —
um INSERT manual dá conflito de chave primária, e ainda mentiria (o arquivo da migration
continua não tendo concedido nada). O script acima de propósito não toca nessa tabela.

⚠️ Com `COUNTRY_RLS_ENABLED=true` a aplicação **recusa subir** sem esta membership (assert
de boot): o serviço entra em crash-loop reclamando dela em vez de servir requests com o
isolamento desligado. Rodar este passo **antes** da virada da conexão (1.3 / 4.3).

### 4. Importar para o terraform (D106 — no MESMO bloco de trabalho)

```bash
cd terraform/environments/$AMBIENTE      # stg | prd
terraform import 'google_sql_user.abac["enlite_runtime"]' "$PROJECT/$INSTANCE/enlite_runtime"
terraform import 'google_sql_user.abac["enlite_system"]'  "$PROJECT/$INSTANCE/enlite_system"
terraform plan   # exigência de saída: NENHUM create/destroy nestes recursos
```

O `lifecycle { ignore_changes = [password] }` é o que impede o próximo `apply` de
sobrescrever a senha viva com o placeholder do HCL — sem ele, o primeiro apply depois do
import derrubaria a conexão do app.

⚠️ **prd**: antes de qualquer `plan`/`apply` ali, confirmar que o checkout tem o
desarme do `0.0.0.0/0` (`git log -1 -- terraform/` batendo com `origin/main` — D104/D106,
memória `terraform-drift-vira-arma`). O `plan` só termina limpo em
`0 to add, 0 to change`, fora o diff perpétuo do header `X-Internal-Secret` dos
schedulers.

### 5. Verificar o que os usuários enxergam (antes de qualquer virada)

```bash
# como enlite_runtime, SEM contexto: a RLS é fail-closed
psql "postgresql://enlite_runtime:$PW@..." -c "SELECT count(*) FROM patients;"   # espera: 0
# como enlite_system, com contexto de sistema declarado
psql "postgresql://enlite_system:$PW@..." \
  -c "SELECT set_config('app.system_context','ops:verificacao',false); SELECT count(*) FROM patients;"
# espera: o total real
```

Zero linhas como `enlite_runtime` **é o resultado certo**, não uma falha de permissão:
sem `app.user_country` a policy não casa nada.

## Rollback

A conexão do app só muda na task 4.1/4.3 (variável de ambiente do Cloud Run). Enquanto
ela apontar para `enlite_app`, estes usuários são inertes — podem existir sem efeito
nenhum. Para desfazer de verdade:

```bash
psql -c "REVOKE app_runtime FROM enlite_runtime; REVOKE app_system FROM enlite_system;"
gcloud sql users delete enlite_runtime --instance="$INSTANCE" --project="$PROJECT"
gcloud sql users delete enlite_system  --instance="$INSTANCE" --project="$PROJECT"
terraform state rm 'google_sql_user.abac["enlite_runtime"]' 'google_sql_user.abac["enlite_system"]'
```

Reverter a connection do app depois da virada é **evento de segurança** (lex C5): exige
registro de quem/quando/por quê no diário, além do log estruturado.

## Alvo de longo prazo (fora desta change)

Autenticação IAM do Cloud SQL (`type = "CLOUD_IAM_SERVICE_ACCOUNT"`) elimina a senha
inteira — sem rotação, sem secret. Exige a flag `cloudsql.iam_authentication` na
instância, provider google 6.x e a aplicação trocando a senha por um token OAuth.
Escopo próprio, depois do rollout do ABAC.
