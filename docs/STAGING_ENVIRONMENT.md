# Ambiente de Staging — `enlite-stg`

Espelho do `enlite-prd` para validação pré-produção. Provisionado via Terraform em `terraform/environments/stg/`.

## Resumo

| Recurso | prd | stg | Diferença |
|---|---|---|---|
| Project ID | `enlite-prd` | `enlite-stg` | namespace de projeto isolado |
| Cloud SQL `enlite-ar-db` | db-custom-1-3840, 20GB | db-f1-micro, 10GB | tier reduzido pra economia |
| Cloud SQL `enlite-n8n-db-ar` | db-f1-micro, 10GB | db-f1-micro, 10GB | paridade |
| Cloud Run `enlite-frontend` | live, deploy via CI | placeholder até CI/CD | aguarda primeiro deploy |
| Cloud Run `worker-functions` | live, deploy via CI | placeholder até CI/CD | aguarda primeiro deploy |
| Cloud Run `enlite-n8n` | live, custom n8n image | placeholder até CI/CD | aguarda primeiro deploy |
| Buckets GCS | nomes sem sufixo | sufixo `-stg` | namespace global do GCS |
| Secret Manager | 13 secrets com valor | 13 secrets sem valor | popular manualmente (ver abaixo) |
| Service Accounts | 5 SAs | 4 SAs (tf-admin vive em prd) | bindings cross-project pra tf-admin |
| Custom Roles | `ApiKeysLookup` | `ApiKeysLookup` | paridade |
| Firebase Auth | configurado via Console | Web App criado (`1:823776126002:web:977bebf111fd8e3691c82b`); providers manuais | manual setup |
| CI/CD GitHub Actions | `backend-prd.yml`/`frontend-prd.yml` em push p/ `main` | `backend-stg.yml`/`frontend-stg.yml` em push p/ `stage` | Environments + branch policies |

## Fluxo de criação / refresh

### Setup inicial

```bash
# 1. Autenticar
gcloud auth application-default login
export GOOGLE_IMPERSONATE_SERVICE_ACCOUNT=tf-admin@enlite-prd.iam.gserviceaccount.com

# 2. Aplicar Terraform
cd terraform/environments/stg
cp terraform.tfvars.example terraform.tfvars
terraform init
terraform apply
```

### Popular secrets

Os secrets em stg são criados sem valor pelo Terraform. Antes do worker-functions stg subir, popular cada um:

```bash
# Senha do Cloud SQL stg (escolher uma — não copiar de prd!)
echo -n "<senha-stg-cloud-sql>" | gcloud secrets versions add enlite-ar-db-password --data-file=- --project=enlite-stg

# APIs externas — pode reutilizar credenciais de stg/sandbox dos providers, ou as mesmas de prd
for s in groq-api-key sendgrid-api-key twilio-auth-token short-io-api-key short-io-domain \
         talentum-api-email talentum-api-password smtp-app-password \
         internal-token-secret n8n-basic-auth-password n8n-db-password n8n-encryption-key; do
  echo -n "<valor>" | gcloud secrets versions add $s --data-file=- --project=enlite-stg
done
```

### Refresh de schema (rodar migrations)

**Schema inicial já aplicado em 2026-05-08** — 168/168 migrations, 44 tables.
Stg está 4 migrations à frente de prd (163-166 ainda não applicadas em prd).

Para aplicar uma migration nova:

```bash
./scripts/run-migration-stg.sh worker-functions/migrations/<arquivo>.sql
```

Para rerodar tudo do zero (drop schema), usar o runner do worker-functions
com Cloud SQL Proxy ativo:

```bash
cloud-sql-proxy --port 5436 enlite-stg:southamerica-west1:enlite-ar-db &
APP_PASS=$(gcloud secrets versions access latest --secret=enlite-ar-db-password --project=enlite-stg)
DATABASE_URL="postgresql://enlite_app:${APP_PASS}@localhost:5436/enlite_ar" \
  node worker-functions/scripts/run-migrations-docker.js
```

O runner é idempotente (tabela `schema_migrations` track o que já foi aplicado).

### Refresh de dados (dump anonimizado de prd)

**TODO Fase 3** — script `scripts/anonymize-prod-to-stg.sh` em desenvolvimento. Por hora, stg fica com seeds sintéticos via runner padrão.

## Acesso

### URLs Cloud Run stg (placeholder até o primeiro deploy real do CI/CD trocar a imagem)
- Frontend: https://enlite-frontend-vtf37eainq-tl.a.run.app
- Worker functions: https://worker-functions-vtf37eainq-tl.a.run.app
- N8N: https://enlite-n8n-vtf37eainq-tl.a.run.app

Domínio futuro: `stg.enlite.health` (a configurar no DNS via domain mappings quando solicitado).

## CI/CD (GitHub Actions)

Workflows em `.github/workflows/`:

| Arquivo | Trigger | Environment | Cloud Run target |
|---|---|---|---|
| `_backend-quality.yml` | reusable (workflow_call) | — | build + unit tests |
| `_frontend-quality.yml` | reusable (workflow_call) | — | lint + unit tests |
| `backend-prd.yml` | push em `main`, paths `worker-functions/**` | `production` | `enlite-prd` |
| `backend-stg.yml` | push em `stage`, paths `worker-functions/**` | `staging` | `enlite-stg` |
| `frontend-prd.yml` | push em `main`, paths `enlite-frontend/**` | `production` | `enlite-prd` |
| `frontend-stg.yml` | push em `stage`, paths `enlite-frontend/**` | `staging` | `enlite-stg` |
| `backend-e2e.yml` | push/PR em `main`, paths `worker-functions/**` | — | docker-compose local |

PRs disparam só o `quality` reusable. O job `deploy` é gated por `if: github.event_name == 'push' && github.ref == 'refs/heads/<branch>'` + `environment:` com deployment branch policy enforçada pelo GitHub (env `production` só aceita deploy de `main`, env `staging` só de `stage`).

### Workload Identity Federation

Pool e provider já provisionados em ambos os projetos:

- prd: `projects/121472682203/locations/global/workloadIdentityPools/github-pool/providers/github-provider` → `github-deploy-sa@enlite-prd.iam.gserviceaccount.com`
- stg: `projects/823776126002/locations/global/workloadIdentityPools/github-pool/providers/github-provider` → `github-deploy-sa@enlite-stg.iam.gserviceaccount.com`

⚠️ **Hardening pendente**: `attributeCondition` só restringe por `repository`, não por `ref`. Adicionar `assertion.ref == 'refs/heads/main'` (prd) e `refs/heads/stage` (stg) elimina o risco de um workflow malicioso em outra branch se autenticar. Defesa atual está em camada de aplicação (`if:` no workflow).

### Secrets por Environment

Secrets escopados via **GitHub Environments** (não repo-scope). Valores hardcoded comuns (URLs estáticas, project IDs) ficam inline no YAML.

**`staging`** (18/19 configurados):
- Infra: `GCP_PROJECT_ID`, `GCP_PROJECT_NUMBER`, `GCP_WIF_PROVIDER`, `GCP_WIF_SA_EMAIL`, `CLOUD_RUN_SERVICE_URL`
- Backend: `GEMINI_API_KEY`, `GEMINI_MODEL`, `GOOGLE_MAPS_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_WHATSAPP_NUMBER`
- Frontend: `VITE_FIREBASE_*` (6), `VITE_API_WORKER_FUNCTIONS_URL`, `VITE_GOOGLE_MAPS_API_KEY`
- **Pendente:** `GOOGLE_CLIENT_ID` (OAuth Client ID — sem API pública de criação, gerar no Console e copiar do Firebase Google provider)

**`production`** (12/19 migrados do repo-scope):
- Migrados: infra (5) + `GEMINI_MODEL` + `VITE_FIREBASE_*` (6)
- **Pendente migrar** do repo-scope (valores que só o cofre do user tem): `GEMINI_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_MAPS_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_WHATSAPP_NUMBER`, `VITE_API_WORKER_FUNCTIONS_URL`, `VITE_GOOGLE_MAPS_API_KEY`
- Comando: `gh secret set <NAME> --env production --repo gabrielgstein-dev/enlite-monorepo` (prompt sem echo)

Após migrar os 7 críticos, apagar os homônimos do repo-scope com `gh secret delete <NAME> --repo gabrielgstein-dev/enlite-monorepo`.

### Secrets do Cloud Run (Secret Manager, **não** GitHub)

Estes ficam no Secret Manager do projeto e são injetados via `secrets:` no `google-github-actions/deploy-cloudrun`:

- `enlite-ar-db-password` → `DB_PASSWORD`
- `groq-api-key` → `GROQ_API_KEY`
- `twilio-auth-token` → `TWILIO_AUTH_TOKEN`
- `internal-token-secret` → `INTERNAL_TOKEN_SECRET`
- `sendgrid-api-key` → `SENDGRID_API_KEY`

Em stg, populá-los antes do primeiro deploy (a SA `github-deploy-sa@enlite-stg` precisa de acesso de leitura via `enlite-functions-sa` que já tem `roles/secretmanager.secretAccessor`).

### API Keys provisionadas em `enlite-stg`

Criadas via `gcloud services api-keys create` em 2026-05-11:

| Display name | Restrição | Uso |
|---|---|---|
| `Gemini API stg` | service: `generativelanguage.googleapis.com` | `GEMINI_API_KEY` |
| `Maps Server stg` | services: geocoding/places/directions/distance-matrix/timezone | `GOOGLE_MAPS_API_KEY` (backend) |
| `Maps Browser stg` | referer: run.app + stg.enlite.health + localhost:5173 | `VITE_GOOGLE_MAPS_API_KEY` (frontend) |
| `Browser key (auto)` | Firebase Auth + Firestore + Identity Toolkit | `VITE_FIREBASE_API_KEY` |

⚠️ Hoje provisionadas fora do Terraform — TD pra importar pro `terraform/environments/stg/`.

### Banco de dados stg via Cloud SQL Proxy

```bash
cloud-sql-proxy --port 5436 enlite-stg:southamerica-west1:enlite-ar-db
# em outro terminal
psql -h localhost -p 5436 -U enlite_app -d enlite_ar
```

## Componentes manuais (fora do TF)

Esses ficam em FOLLOWUPS pra eventualmente migrar:

- **Firebase Auth providers** (email + Google): habilitar pelo Console em https://console.firebase.google.com/project/enlite-stg/authentication/providers — ao ativar Google, ele cria o OAuth Client ID que vira `GOOGLE_CLIENT_ID` em ambos os ambientes
- **OAuth Client ID stg** (`GOOGLE_CLIENT_ID`): Console > APIs & Services > Credentials > Create OAuth Client ID; depois `gh secret set GOOGLE_CLIENT_ID --env staging`
- **Cloud Run em prd**: foi criado manualmente; importar pra TF v2 é trabalho separado
- **Domínio customizado** (`stg.enlite.health`): mapear via Cloud Run domain mappings quando o DNS estiver pronto
- **API keys de stg em Terraform**: criadas via `gcloud services api-keys create` em 2026-05-11; importar pra `terraform/environments/stg/api_keys.tf`

## Custos estimados

- Cloud SQL `enlite-ar-db` stg (db-f1-micro): ~$10/mês
- Cloud SQL `enlite-n8n-db-ar` stg (db-f1-micro): ~$10/mês
- Cloud Run: pay-per-use, baixíssimo se idle
- GCS / Artifact Registry: storage marginal
- **Total esperado: $20–30/mês** (vs ~$60/mês de prd)
