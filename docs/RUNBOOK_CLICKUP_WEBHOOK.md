# Runbook — Webhook ClickUp → Enlite (sync de pacientes em tempo real)

> **Quando usar:** primeira ativação em produção, troubleshooting, ou rotação do secret.
> **Pré-requisitos:** `gcloud` autenticado em `enlite-prd`, `CLICKUP_API_TOKEN` válido no `.env`.

---

## Arquitetura resumida

```
ClickUp task event
  └─► POST https://<worker-functions-url>/api/webhooks/clickup/patient
      ├─ HMAC verify (X-Signature ↔ CLICKUP_WEBHOOK_SECRET)
      ├─ list_id == 901304883903 (Estado de Pacientes)
      ├─ GET task completa via API ClickUp
      └─► SyncPatientFromClickUpTaskUseCase.execute(task)
            └─► PatientService.upsertFromClickUp(input)
                  └─► patients table (UNIQUE case_number active)
```

Eventos cobertos: `taskCreated`, `taskUpdated`, `taskStatusUpdated`, `taskMoved`, `taskDeleted` (soft-delete via `deleted_at`).

---

## Setup inicial em produção

### 1. Identificar a URL pública do Cloud Run

```bash
gcloud run services describe worker-functions \
  --region=southamerica-west1 --project=enlite-prd \
  --format='value(status.url)'
```

Resultado esperado: `https://worker-functions-<hash>-rj.a.run.app`. Sufixe `/api/webhooks/clickup/patient` pra obter a URL do endpoint.

### 2. Registrar o webhook no ClickUp

```bash
cd worker-functions
set -a && source .env && set +a

# Verificar webhooks existentes (deve estar vazio antes do primeiro setup)
npx ts-node -r tsconfig-paths/register scripts/register-clickup-webhook.ts --list

# Registrar
npx ts-node -r tsconfig-paths/register scripts/register-clickup-webhook.ts \
  --endpoint https://worker-functions-<hash>-rj.a.run.app/api/webhooks/clickup/patient
```

A saída inclui:

```
✅ Webhook registered
   ID:       <uuid>
   Secret:   <hex-string>   ← COPIAR AGORA
   Endpoint: https://...
   Events:   [taskCreated, taskUpdated, taskStatusUpdated, taskMoved, taskDeleted]
   List:     901304883903 (Estado de Pacientes)
```

> **CRÍTICO:** o `secret` aparece **uma única vez**. Não há como recuperar — em caso de perda, deletar o webhook e recriar.

### 3. Salvar o secret no Secret Manager

```bash
echo -n "<paste-do-secret-acima>" | gcloud secrets create clickup-webhook-secret \
  --data-file=- \
  --project=enlite-prd \
  --replication-policy=automatic
```

Conferir:

```bash
gcloud secrets versions access latest --secret=clickup-webhook-secret --project=enlite-prd
```

### 4. Conceder leitura à service account do Cloud Run

```bash
gcloud secrets add-iam-policy-binding clickup-webhook-secret \
  --member=serviceAccount:enlite-functions-sa@enlite-prd.iam.gserviceaccount.com \
  --role=roles/secretmanager.secretAccessor \
  --project=enlite-prd
```

### 5. Atualizar Cloud Run com a nova env var

```bash
gcloud run services update worker-functions \
  --region=southamerica-west1 \
  --project=enlite-prd \
  --update-secrets=CLICKUP_WEBHOOK_SECRET=clickup-webhook-secret:latest
```

Isso dispara um novo revision automaticamente. Aguarde 30-60s.

### 6. Verificar saúde do webhook

```bash
# Logs do Cloud Run filtrando por clickup_webhook
gcloud run services logs read worker-functions \
  --region=southamerica-west1 \
  --project=enlite-prd \
  --limit=50 \
  --filter='textPayload:"clickup_webhook"'
```

Após registrar o webhook, o ClickUp envia um evento `webhook_health` periódico. O log esperado é `clickup_webhook.received`. Se aparecer `clickup_webhook.hmac_invalid`, o secret está dessincronizado entre Secret Manager e ClickUp — refazer passos 2-5.

Status do webhook na ClickUp:

```bash
npx ts-node -r tsconfig-paths/register scripts/register-clickup-webhook.ts --list
```

Procurar pelo campo `health.status` — deve ser `active`.

---

## Operações comuns

### Rotacionar o secret

ClickUp não permite regenerar secret de um webhook existente. O fluxo é:

```bash
# 1. Deletar o webhook atual (anote o ID via --list)
npx ts-node -r tsconfig-paths/register scripts/register-clickup-webhook.ts --delete <webhook_id>

# 2. Registrar novo (gera secret novo)
npx ts-node -r tsconfig-paths/register scripts/register-clickup-webhook.ts --endpoint <url>

# 3. Adicionar nova versão ao secret
echo -n "<novo-secret>" | gcloud secrets versions add clickup-webhook-secret \
  --data-file=- --project=enlite-prd

# 4. Cloud Run pega a nova versão automaticamente (latest), mas pra forçar:
gcloud run services update worker-functions \
  --region=southamerica-west1 --project=enlite-prd \
  --update-secrets=CLICKUP_WEBHOOK_SECRET=clickup-webhook-secret:latest
```

### Backfill manual (reconciliar gaps)

Se o webhook ficar offline (deploy, rollback, ClickUp incident), rodar o script CLI pra re-sincronizar:

```bash
cd worker-functions
set -a && source .env && set +a

# Dry-run primeiro (sem escrever)
npx ts-node -r tsconfig-paths/register scripts/import-patients-from-clickup.ts --dry-run --limit 10

# Live (escrita real)
npx ts-node -r tsconfig-paths/register scripts/import-patients-from-clickup.ts --live
```

> Em produção, o `DATABASE_URL` precisa apontar pro Cloud SQL (via Cloud SQL Proxy). Ver `docs/COMANDOS_CONFIGURACAO_DB.md`.

### Pausar o webhook

Pra pausar sem deletar (ex: durante incident):

```bash
# Opção 1: remover env do Cloud Run (rota fica desregistrada no startup)
gcloud run services update worker-functions \
  --region=southamerica-west1 --project=enlite-prd \
  --remove-env-vars=CLICKUP_WEBHOOK_SECRET

# Opção 2: deletar o webhook no ClickUp (mais limpo, mas precisa recriar)
npx ts-node -r tsconfig-paths/register scripts/register-clickup-webhook.ts --delete <id>
```

---

## Troubleshooting

| Sintoma | Diagnóstico | Resolução |
|---|---|---|
| `clickup_webhook.hmac_invalid` em todos os requests | Secret no Secret Manager ≠ secret do ClickUp | Refazer passos 2-5 do setup |
| `clickup_webhook.fetch_task_failed` constante | `CLICKUP_API_TOKEN` revogado/expirado | Renovar token em ClickUp Settings → Apps |
| `clickup_webhook.skip_other_list` em alta frequência | ClickUp registrou webhook em escopo errado | Verificar `--list` — `list_id` deve ser `901304883903` |
| Webhook nunca dispara | Health=`failing` na ClickUp | Verificar Cloud Run está `Ready`; testar endpoint com curl + HMAC |
| Pacientes com `needs_attention=CASE_NUMBER_CONFLICT` aparecendo | Duplicidade de `case_number` no ClickUp | Operação resolve no ClickUp (TD-008 em `FOLLOWUPS.md`) |

---

## Métricas/observabilidade

Logs estruturados disponíveis em Cloud Logging (filtros sugeridos):

- `textPayload:"clickup_patient_sync.completed"` — todos os syncs bem-sucedidos
- `textPayload:"clickup_patient_sync.case_number_conflict"` — alertar em ≥1/dia
- `textPayload:"clickup_webhook.hmac_invalid"` — alertar em ≥5/min (possível ataque)
- `textPayload:"clickup_webhook.fetch_task_failed"` — alertar em ≥3/min

Query mestra de saúde:

```
clickup_patient_sync.completed(últimas 24h) ÷ count(tasks ClickUp 'Estado de Pacientes')
```

Se < 100% por mais de 1h, rodar backfill manual.
