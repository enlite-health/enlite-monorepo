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
| Firebase Auth | configurado via Console | precisa configurar Console | manual setup |

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

```bash
./scripts/run-migration-stg.sh worker-functions/migrations/<arquivo>.sql
```

Pra rodar todas em sequência, usar o runner do worker-functions ajustado pra apontar pra stg (ver Fase 2 do plano).

### Refresh de dados (dump anonimizado de prd)

**TODO Fase 3** — script `scripts/anonymize-prod-to-stg.sh` em desenvolvimento. Por hora, stg fica com seeds sintéticos via runner padrão.

## Acesso

### URLs Cloud Run stg (placeholder — primeiro deploy real do CI/CD vai trocar a imagem)
- Frontend: https://enlite-frontend-vtf37eainq-tl.a.run.app
- Worker functions: https://worker-functions-vtf37eainq-tl.a.run.app
- N8N: https://enlite-n8n-vtf37eainq-tl.a.run.app

Domínio futuro: `stg.enlite.health` (a configurar no DNS via domain mappings quando solicitado).

### Banco de dados stg via Cloud SQL Proxy

```bash
cloud-sql-proxy --port 5436 enlite-stg:southamerica-west1:enlite-ar-db
# em outro terminal
psql -h localhost -p 5436 -U enlite_app -d enlite_ar
```

## Componentes manuais (fora do TF)

Esses ficam em FOLLOWUPS pra eventualmente migrar:

- **Firebase Auth providers** (email + Google): habilitar pelo Console em https://console.firebase.google.com/project/enlite-stg/authentication/providers
- **Cloud Run em prd**: foi criado manualmente; importar pra TF v2 é trabalho separado
- **Domínio customizado** (`stg.enlite.health`): mapear via Cloud Run domain mappings quando o DNS estiver pronto
- **CI/CD branch staging**: workflow `.github/workflows/deploy-stg.yml` ainda a criar

## Custos estimados

- Cloud SQL `enlite-ar-db` stg (db-f1-micro): ~$10/mês
- Cloud SQL `enlite-n8n-db-ar` stg (db-f1-micro): ~$10/mês
- Cloud Run: pay-per-use, baixíssimo se idle
- GCS / Artifact Registry: storage marginal
- **Total esperado: $20–30/mês** (vs ~$60/mês de prd)
