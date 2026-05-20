# Runbook: Bulk Dispatch (Cadastro Incompleto + Talentum Incompleto)

> Sprint origem: `docs/SPRINT_RECRUITMENT_AUTOMATION.md` (Fases 4+5, commits `72dc85a` e `c21a805`)
> Última atualização: 2026-05-19

## O que é

Dois fluxos cron que rodam diariamente enviando lembretes WhatsApp:

1. **Cadastro incompleto** (`/api/internal/bulk-dispatch/process`): workers que se cadastraram mas não terminaram o onboarding interno (documentos faltando, perfil incompleto). Template `complete_register_ofc`.
2. **Talentum incompleto** (`/api/internal/bulk-dispatch/talentum-incomplete`): workers com `application_funnel_stage IN ('INITIATED', 'IN_PROGRESS')`. Cadência: **1º envio após 1 dia de inatividade + 2º envio 3 dias depois do 1º, cap em 2** (se ainda não completou após 2 tentativas, para). Template `talentum_incomplete_reminder`.

## Cloud Scheduler

Yamls em `worker-functions/gcp/scheduler/`:
- `bulk-dispatch.yaml` — cadastro incompleto
- `bulk-dispatch-talentum.yaml` — Talentum incompleto

Config aplicada em prd + stg (naming idêntico, memória `feedback_naming_prd_stg`):

| Campo | Valor |
|---|---|
| Schedule | `0 13 * * *` (10h BRT = 13h UTC) |
| Timezone | `Etc/UTC` |
| HTTP method | POST |
| Headers | `Authorization: Bearer ${INTERNAL_TOKEN_SECRET}` |
| Body | `{}` |
| attemptDeadline | `600s` (10min — suficiente p/ ~400 workers a 1500ms cada) |
| retryCount | `0` (idempotência via worker_reminder_state cobre — não retry) |

### Como criar no GCP

```bash
gcloud scheduler jobs create http bulk-dispatch \
  --schedule="0 13 * * *" \
  --uri="${CLOUD_RUN_URL}/api/internal/bulk-dispatch/process" \
  --http-method=POST \
  --headers="Authorization=Bearer ${INTERNAL_TOKEN_SECRET},Content-Type=application/json" \
  --message-body="{}" \
  --attempt-deadline=600s \
  --max-retry-attempts=0 \
  --location=southamerica-east1
```

Repetir trocando `bulk-dispatch` → `bulk-dispatch-talentum` e o path do uri.

## Idempotência (Fase 5)

Tabela `worker_reminder_state` (migration 176):
- PK composta `(worker_id, template_slug, sent_date)` — lock atomic
- `status IN ('pending', 'sent', 'failed')`
- `batch_id` — referência cruzada com `whatsapp_bulk_dispatch_logs`

Comportamento:
1. Antes do envio Twilio: `INSERT ON CONFLICT DO NOTHING RETURNING worker_id`
2. Se RETURNING vazio: outro processo já adquiriu o slot do dia → skip
3. Se RETURNING tem row: envia Twilio → `UPDATE status = 'sent'/'failed'`
4. Worker com `failed` no dia **não** retenta hoje (filtro `sent_date = CURRENT_DATE`)

### Backfill no deploy

Migration 176 popula `worker_reminder_state` com `status='sent'` a partir de `whatsapp_bulk_dispatch_logs` da data atual — evita reenvio massivo logo após deploy.

## Como debugar

### "Worker não recebeu reminder"

```sql
-- 1. Worker é elegível?
-- Para cadastro incompleto:
SELECT w.id, w.email, w.status
FROM workers w
WHERE w.id = '<workerId>'
  AND w.status != 'DISABLED'
  AND w.phone IS NOT NULL
  AND w.email NOT LIKE '%@enlite.import';

-- Para Talentum incompleto:
SELECT wja.application_funnel_stage, wja.updated_at, NOW() - wja.updated_at AS age
FROM worker_job_applications wja
WHERE wja.worker_id = '<workerId>'
  AND wja.application_funnel_stage IN ('INITIATED', 'IN_PROGRESS');
-- age < 5 days → não elegível ainda
```

```sql
-- 2. State do dia
SELECT * FROM worker_reminder_state
WHERE worker_id = '<workerId>'
  AND sent_date = CURRENT_DATE;
-- Sem row: cron ainda não rodou, ou worker não entrou na query
-- status='pending': processo iniciou mas não terminou (talvez crash; ver TD-021)
-- status='sent': enviou; verificar whatsapp_bulk_dispatch_logs
-- status='failed': Twilio rejeitou, ver dispatch_logs.error_message
```

```sql
-- 3. Log do envio
SELECT * FROM whatsapp_bulk_dispatch_logs
WHERE worker_id = '<workerId>'
  AND template_slug IN ('complete_register_ofc', 'talentum_incomplete_reminder')
ORDER BY dispatched_at DESC LIMIT 1;
```

### Trigger manual

```bash
curl -X POST https://<api>/api/internal/bulk-dispatch/process \
  -H "Authorization: Bearer ${INTERNAL_TOKEN_SECRET}"

curl -X POST https://<api>/api/internal/bulk-dispatch/talentum-incomplete \
  -H "Authorization: Bearer ${INTERNAL_TOKEN_SECRET}"
```

Worker que já recebeu hoje vai ser skippado pelo lock atomic.

## Retenção e cleanup

`worker_reminder_state` cresce ~N rows/dia. Cleanup mensal (configurar cron pg_cron ou Cloud Scheduler weekly):

```sql
DELETE FROM worker_reminder_state WHERE sent_date < CURRENT_DATE - INTERVAL '30 days';
```

## Pré-requisitos de produção

- **TD-020 (FOLLOWUPS.md)**: template `talentum_incomplete_reminder` precisa de `content_sid` HSM antes do go-live
- **TD-021 (FOLLOWUPS.md)**: bug pré-existente em `INCOMPLETE_WORKERS_QUERY` (`preferred_types = '{}'` mal-formado) bloqueia `/bulk-dispatch/process` em E2E ponta-a-ponta — fix necessário antes de ativar Cloud Scheduler de cadastro incompleto

## Alertas (DP-006)

| Alerta | Métrica | Threshold |
|---|---|---|
| Bulk dispatch silenciou | `whatsapp_bulk_dispatch_logs` rows hoje p/ template = 0 após 11h BRT | crítico |
| Taxa de erro alta | `errors / total > 30%` na última execução (consultar `/admin/recruitment/health`) | warning |
| Volume anormal | `total` >2x média de 7 dias | warning |
