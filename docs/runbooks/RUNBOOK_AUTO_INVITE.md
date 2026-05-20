# Runbook: Convite Automático Pós-Match (Fluxo A)

> Sprint origem: `docs/SPRINT_RECRUITMENT_AUTOMATION.md` (Fase 3, commit `dbf16f8`)
> Última atualização: 2026-05-19

## O que é

Quando admin cria uma vaga via `POST /api/admin/vacancies`, o sistema dispara automaticamente WhatsApp pra cada AT que deu match (endereço + sexo + tipo de profissão).

## Arquitetura

```
POST /admin/vacancies
  └─> setImmediate INSERT INTO domain_events (event='vacancy.created', payload={jobPostingId})
       └─> Pub/Sub topic 'domain-events' (push em segundos)
            └─> POST /api/internal/events/process
                 └─> DomainEventProcessor → VacancyAutoInviteHandler
                      ├─> MatchmakingService.matchWorkersForJob(jobPostingId)
                      │     (grava INVITED em worker_job_applications)
                      ├─> filter candidates.alreadyApplied=false
                      ├─> per candidate:
                      │     - SELECT EXISTS dedup (7 dias)
                      │     - INSERT messaging_outbox (vacancy_invited_auto)
                      │     - Pub/Sub 'outbox-enqueued'
                      └─> OutboxProcessor envia WhatsApp + grava log
```

Safety net: se Pub/Sub falhar, sweep de 5min (`/api/internal/events/sweep`) reprocessa.

## Como debugar

### "AT não recebeu convite"

```sql
-- 1. Confirma que vaga gerou domain_event
SELECT id, status, error, created_at, processed_at
FROM domain_events
WHERE event = 'vacancy.created'
  AND payload->>'jobPostingId' = '<vacancyId>';
-- status='pending' → ainda não processado
-- status='failed' → ler coluna error
-- status='processed' → handler rodou
```

```sql
-- 2. Confirma que o worker estava no matching result
SELECT wja.application_funnel_stage, wja.match_score, wja.updated_at
FROM worker_job_applications wja
WHERE wja.worker_id = '<workerId>'
  AND wja.job_posting_id = '<vacancyId>';
-- Sem row: matching nem retornou esse worker (check raio + filtros)
-- Row com INVITED: matching ok, problema downstream
```

```sql
-- 3. Confirma idempotência não bloqueou
SELECT id, status, created_at, processed_at, error
FROM messaging_outbox
WHERE worker_id = '<workerId>'
  AND job_posting_id = '<vacancyId>'
  AND template_slug = 'vacancy_invited_auto'
ORDER BY created_at DESC LIMIT 5;
-- Sem row: handler pulou (verificar logs do handler)
-- status='pending': outbox ainda não processou
-- status='sent': enviou → próximo passo é Twilio webhook
-- status='failed': ler error
```

```sql
-- 4. Confirma envio
SELECT * FROM whatsapp_bulk_dispatch_logs
WHERE worker_id = '<workerId>'
  AND template_slug = 'vacancy_invited_auto'
ORDER BY dispatched_at DESC LIMIT 1;
-- status='sent' + twilio_sid: enviou; delivery_status mostra delivery
-- status='error': ler error_message
```

### Cloud Logging (após Fase 0)

Filtrar por `jsonPayload.traceId = "<traceId>"` agrupa toda a cadeia da request. Para o handler:
- `jsonPayload.handler = "VacancyAutoInvite"`
- `jsonPayload.jobPostingId = "<vacancyId>"`

## Replay manual

Se um domain_event ficou `failed` ou perdido:

```sql
-- Forçar retry (sweep vai pegar na próxima rodada de 5min):
UPDATE domain_events SET status='pending', error=NULL
WHERE id = '<eventId>';
```

Ou disparar manualmente:
```bash
curl -X POST https://<api>/api/internal/events/sweep \
  -H "Authorization: Bearer ${INTERNAL_TOKEN_SECRET}"
```

## Pré-requisitos de produção

**TD-018 (FOLLOWUPS.md)**: o template `vacancy_invited_auto` tem `content_sid = NULL`. WhatsApp Business rejeita mensagens proativas sem HSM aprovado. Antes do go-live:

1. Ops registra `vacancy_invited_auto` no Twilio Content Builder
2. Variables: `worker_name`, `vacancy_case_number`, `distance_km`, `patient_zone`
3. Submete pra aprovação HSM da Meta (~dias)
4. Ao receber SID aprovado, rodar em prod:
   ```sql
   UPDATE message_templates
   SET content_sid = 'HX...'
   WHERE slug = 'vacancy_invited_auto';
   ```

## Alertas e SLAs (Cloud Monitoring — DP-006)

Configurar alerta:
- Métrica: COUNT de `whatsapp_bulk_dispatch_logs` WHERE `source='outbox'` AND `template_slug='vacancy_invited_auto'` AND `status='error'` na última 1h
- Threshold: > 5 → notificar canal #enlite-alerts
- Severidade: WARNING

Dashboard: `GET /api/admin/recruitment/health` (Fase 6) exibe contadores 24h.
