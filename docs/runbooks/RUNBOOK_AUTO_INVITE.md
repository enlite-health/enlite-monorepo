# Runbook: Convite Automático Pós-Match (Fluxo A)

> Sprint origem: `docs/SPRINT_RECRUITMENT_AUTOMATION.md` (Fase 3) + integração templates Twilio aprovados (commit `4774c93`) + suporte INCOMPLETE_REGISTER
> Última atualização: 2026-05-20

## O que é

Quando admin cria uma vaga via `POST /api/admin/vacancies`, o sistema dispara automaticamente WhatsApp pra cada AT que deu match (endereço + sexo + tipo de profissão), com **template diferente baseado no status do AT**:

| Worker status | Template Twilio | Copy enviado |
|---|---|---|
| `REGISTERED` | `ar_vacancy_match_complete` (HXa1ff...) | "Llegó una nueva oportunidad... Inscribite a la entrevista acá: {vacancy_url}" |
| `INCOMPLETE_REGISTER` | `ar_vacancy_match_incomplete` (HXd8cd...) | "Llegó una oportunidad... Para postularte, todavía necesitamos: {pending_documents}. Completá tu perfil y postulate acá: {vacancy_url}" |

## Arquitetura

```
POST /admin/vacancies
  └─> setImmediate INSERT INTO domain_events (event='vacancy.created', payload={jobPostingId})
       └─> Pub/Sub topic 'domain-events' (push em segundos)
            └─> POST /api/internal/events/process
                 └─> DomainEventProcessor → VacancyAutoInviteHandler
                      ├─> MatchmakingService.matchWorkersForJob(jobPostingId,
                      │      { includeIncompleteRegister: true })
                      │     (grava INVITED em worker_job_applications;
                      │      retorna workers REGISTERED + INCOMPLETE_REGISTER)
                      ├─> filter candidates.alreadyApplied=false
                      ├─> per candidate:
                      │     - Decide template por candidate.workerStatus
                      │     - SELECT EXISTS dedup (7 dias, ambos templates)
                      │     - Se INCOMPLETE: query worker_documents pra montar
                      │       pending_documents ("tu CV, tu DNI y tu monotributo")
                      │     - INSERT messaging_outbox (template escolhido)
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
SELECT id, status, template_slug, created_at, processed_at, error
FROM messaging_outbox
WHERE worker_id = '<workerId>'
  AND job_posting_id = '<vacancyId>'
  AND template_slug IN ('ar_vacancy_match_complete', 'ar_vacancy_match_incomplete')
ORDER BY created_at DESC LIMIT 5;
-- Sem row: handler pulou (verificar logs do handler)
-- status='pending': outbox ainda não processou
-- status='sent': enviou → próximo passo é Twilio webhook
-- status='failed': ler error
-- template_slug='ar_vacancy_match_complete': worker REGISTERED
-- template_slug='ar_vacancy_match_incomplete': worker INCOMPLETE_REGISTER
```

```sql
-- 4. Confirma envio
SELECT * FROM whatsapp_bulk_dispatch_logs
WHERE worker_id = '<workerId>'
  AND template_slug IN ('ar_vacancy_match_complete', 'ar_vacancy_match_incomplete')
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

Resolvido em 2026-05-20 (commits `4774c93` + posteriores). Templates Twilio aprovados:

| Slug | content_sid Twilio | Status Meta |
|---|---|---|
| `ar_vacancy_match_complete` | `HXbd608e95260a97d1da8f9e21c9eae77a` | ✅ approved |
| `ar_vacancy_match_incomplete` | `HX28e3f10dde62eae90999fe1cf9bf23b3` | ✅ approved |

> **2026-06-18** — content_sids trocados pelos templates `_v2` (migration 211).
> Os antigos `HXa1ff7c9189b625587929c5f19e4e614f` / `HXd8cd5071c998317731286be3e5164854`
> tinham o link quebrado (`{{vacancy_url}}.` com ponto colado → tela branca) e foram
> **deletados** do Twilio. A rota correta é `/vacantes/:id` (ES), não `/vacancies` (EN).

Slug antigo `vacancy_invited_auto` (migration 174) foi desativado (`is_active=false`) — não usado mais.

## Alertas e SLAs (Cloud Monitoring — DP-006)

Configurar alerta:
- Métrica: COUNT de `whatsapp_bulk_dispatch_logs` WHERE `source='outbox'` AND `template_slug IN ('ar_vacancy_match_complete', 'ar_vacancy_match_incomplete')` AND `status='error'` na última 1h
- Threshold: > 5 → notificar canal #enlite-alerts
- Severidade: WARNING

Dashboard: `GET /api/admin/recruitment/health` (Fase 6) exibe contadores 24h.
