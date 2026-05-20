# Runbook: Observabilidade do worker-functions

> Sprint origem: `docs/SPRINT_RECRUITMENT_AUTOMATION.md` (Fases 0+1+2, commits `c15f373`, `52f9a44`, `9f6d281`)
> Última atualização: 2026-05-19

## Stack

| Camada | Tecnologia |
|---|---|
| Logging | `pino@10` (JSON estruturado) |
| Severity mapping | `pino formatters.level` → GCP `severity` |
| Context propagation | `AsyncLocalStorage` (Node 20) |
| HTTP trace | header `X-Cloud-Trace-Context` (Cloud Run injeta) |
| Async trace | coluna `trace_id` em `messaging_outbox` e `domain_events` |
| Error tracker | Cloud Error Reporting (auto-detecta logs `severity=ERROR` com `@type` field) |
| Audit | `worker_status_history`, `worker_job_application_stage_history`, `whatsapp_bulk_dispatch_logs` |

## Como achar logs

### Por traceId (request ponta a ponta)

```
jsonPayload.traceId = "abc123trace"
```

Cobre: HTTP request inteira + qualquer outbox/domain_event que ela tenha enfileirado (graças à coluna `trace_id` persistida na Fase 1).

### Por worker

```
jsonPayload.workerId = "uuid-do-worker"
```

Captura logs de qualquer use case/handler que tenha feito `logger.child({ workerId })` (padrão estabelecido em BulkDispatch e VacancyAutoInviteHandler).

### Por batch (bulk dispatch)

```
jsonPayload.batchId = "uuid-do-batch"
```

Identifica todos os logs de uma execução específica de `BulkDispatchIncompleteWorkersUseCase` ou `BulkDispatchTalentumIncompleteUseCase`.

### Por job posting

```
jsonPayload.jobPostingId = "uuid-da-vaga"
```

Cobre logs do `VacancyAutoInviteHandler` (Fase 3) processando aquela vaga.

## Padrão de uso do logger

```ts
import { logger, reportError, loggingAls } from '@shared/logging';

// 1. Logger raiz já injeta traceId automaticamente via AsyncLocalStorage
logger.info({ msg: 'starting work' });

// 2. Child logger com contexto adicional
const log = logger.child({ workerId, jobPostingId });
log.info({ msg: 'doing thing', count: candidates.length });

// 3. Reportar erro pro Cloud Error Reporting
try {
  await risky();
} catch (err) {
  const e = err instanceof Error ? err : new Error(String(err));
  log.warn({ error: e.message }, 'fallback acionado');
  reportError(e, { source: 'MyUseCase:risky', workerId });
}

// 4. Restaurar traceId em job assíncrono (padrão OutboxProcessor + DomainEventProcessor)
await loggingAls.run({ traceId: row.trace_id ?? uuidv4(), workerId: row.worker_id }, async () => {
  await handler(row);
});
```

NUNCA usar `console.log/warn/error` em código novo — decisão DP-007 (incremental para legacy). Logs antigos ainda existem nos 449 `console.*` não tocados; futuras edições em arquivos legados devem migrar pra `logger` ao tocar.

## Cloud Error Reporting

Erros vão automaticamente pra Cloud Error Reporting quando:
1. `severity >= ERROR` no log (mapeado por `pino` via `formatters.level`)
2. Campo `@type: type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent`
3. Campo `stack_trace` presente

`reportError()` faz isso tudo. Erro agrupado automaticamente.

Console GCP: https://console.cloud.google.com/errors

## Audit history

### Mudanças de `workers.status`

```sql
SELECT * FROM worker_status_history
WHERE worker_id = '<workerId>'
ORDER BY created_at DESC;
```

Trigger `trg_worker_status_history` (migration 079, refatorado em 096) grava transições. `changed_by` vem de `current_setting('app.current_uid', true)` — NULL quando UPDATE não veio via controller admin.

### Mudanças de `worker_job_applications.application_funnel_stage` (Fase 1)

```sql
SELECT * FROM worker_job_application_stage_history
WHERE application_id IN (
  SELECT id FROM worker_job_applications WHERE worker_id = '<workerId>'
)
ORDER BY created_at DESC;
```

Trigger `trg_application_stage_history` (migration 169) grava INSERT inicial (`NULL → INITIATED`) e UPDATEs subsequentes.

### Timeline completa de um worker

Endpoint: `GET /api/admin/workers/:id/timeline` (Fase 1, paginado)

UNION ALL de:
- `worker_status_history` (kind=`status_change`)
- `worker_job_application_stage_history` (kind=`funnel_stage`)
- `whatsapp_bulk_dispatch_logs` (kind=`whatsapp`)

Ordenado por timestamp DESC. Inclui `source` da mensagem (bulk / individual / outbox — Fase 2).

## Dashboard de saúde (Fase 6)

`GET /api/admin/recruitment/health` ou page `/admin/recruitment/health` no admin frontend:

- Auto-invite last 24h: vacancies created / invites enqueued / sent / delivered / failed
- Bulk dispatch incomplete last run: batch_id, total, sent, errors, timestamps
- Bulk dispatch Talentum last run: idem

## Gaps conhecidos

- **TD-017**: `onUserCreate.ts` (Firebase trigger) não propaga `traceId` via ALS — Firebase Functions runtime não passa pelo correlationMiddleware. Solução manual: `logger.child({ traceId: uuidv4(), source: 'firebase-trigger' })` quando tocar.
- 449 `console.*` legados não migrados — DP-007 incremental. Migrar ao tocar.
