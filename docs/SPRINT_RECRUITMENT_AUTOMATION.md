# Sprint: Automação de Recrutamento + Observabilidade Ponta-a-Ponta

> **Status:** EM EXECUÇÃO (criado 2026-05-19)
> **Progresso:** Fase 0 ✅ concluída (2026-05-19) — fases 1-8 pendentes
> **Estimativa:** 1 sprint (8-12 dias úteis) em 8 fases sequenciais
> **Pré-requisito de:** features futuras de personalização com IA, dashboards de SLA de delivery
> **Auditoria-base:** mapeamento do architect em 2026-05-19 (no histórico desta conversa)

---

## 1. Sumário Executivo

O objetivo do sprint é fechar **dois fluxos críticos de recrutamento** que hoje rodam parcialmente (ou nem rodam) e, no caminho, instalar a base de **rastreabilidade ponta-a-ponta** para que o time consiga responder a três perguntas hoje impossíveis:

1. "O AT X recebeu a mensagem que devia receber? Quando? Com que template?"
2. "O fluxo Y rodou hoje? Falhou em alguém? Onde?"
3. "Qual o caminho de transição de status do worker Z desde o cadastro?"

**Fluxo A — Convite automático pós-criação de vaga**
- Trigger: vaga criada
- Ação: matchmaking (endereço + sexo + profissão) → WhatsApp pra cada match → status `INVITED`
- Hoje: matchmaking roda e grava `INVITED` no banco, **mas WhatsApp não dispara automático**

**Fluxo B — Lembrete de cadastro/Talentum incompleto**
- Trigger: cron diário
- Ação: query workers parados → WhatsApp de reembarque
- Hoje: query de cadastro interno incompleto funciona; **query de Talentum incompleto não existe; sem dedup contra duplicação**

A premissa do sprint é: **observabilidade vem antes da automação**. Sem logging estruturado, correlationId, error tracking e auditoria de transições, qualquer feature nova é construída em terreno onde a gente não consegue verificar se está funcionando.

---

## 2. Contexto e Objetivo

### Estado atual (verificado pelo architect em 2026-05-19)

**O que existe e funciona:**
- `MatchmakingService.matchWorkersForJob()` em `worker-functions/src/modules/matching/infrastructure/MatchmakingService.ts:55` — match por endereço/sexo/profissão completo
- `saveMatchResults()` grava `application_funnel_stage = 'INVITED'` em `worker_job_applications`
- Auto-match dispara em `VacancyCrudController.ts:142` via `setImmediate` quando vaga é criada
- Infra Pub/Sub + Cloud Tasks + tabela `messaging_outbox` (Outbox pattern) em `src/shared/events/`
- Twilio WhatsApp via `TwilioMessagingService` + `IMessagingService` port
- Templates `vacancy_match`, `complete_register_ofc`, `talent_search_welcome`, `qualified_worker_request`
- Cloud Scheduler diário 10h BRT → `POST /api/internal/bulk-dispatch/process`
- `BulkDispatchIncompleteWorkersUseCase.INCOMPLETE_WORKERS_QUERY` (Query 1 do Fluxo B)
- Tabela `whatsapp_bulk_dispatch_logs` (log de envios em massa)
- Tabela `worker_status_history` (audit de `workers.status` via trigger)
- `delivery_status` atualizado via webhook Twilio (`TWILIO_STATUS_CALLBACK_URL`)
- `domain_events` + `DomainEventProcessor` (handler `funnel_stage.qualified` já registrado)

**O que falta (gap real):**

| Categoria | Gap |
|---|---|
| Fluxo A | Conectar `saveMatchResults` → enfileirar no `messaging_outbox` (zero loc fazendo isso hoje) |
| Fluxo A | `setImmediate` atual é fire-and-forget sem retry — trocar por `domain_event` |
| Fluxo B | Query 2: workers Talentum em `INITIATED`/`IN_PROGRESS` há >N dias (NÃO EXISTE) |
| Fluxo B | Dedup: re-execução do cron duplica WhatsApp pro mesmo worker (NÃO EXISTE) |
| Observabilidade | Logging estruturado (hoje só `console.log` puro) |
| Observabilidade | CorrelationId/traceId propagado entre layers (hoje inexistente) |
| Observabilidade | Error tracking (zero Sentry/Cloud Error Reporting hoje; erros silenciados em vários `catch(() => {})`) |
| Observabilidade | Auditoria de `application_funnel_stage` (só `updated_at` na linha hoje) |
| Observabilidade | `batch_id` no bulk dispatch (impossível agrupar logs de uma execução) |
| Observabilidade | Envio manual de WhatsApp (`MessagingController.sendToWorker`) não grava log nenhum |

### Objetivo do sprint

1. Toda mensagem WhatsApp enviada pela plataforma tem **registro auditável** (worker, template, SID, batch, timestamp, delivery status).
2. Toda transição de `application_funnel_stage` é **auditável historicamente** (não só o estado atual).
3. Erros em qualquer job/handler são **capturados e alertados**, nunca silenciados.
4. Logs de uma única request/execução de job são **agrupáveis** via correlationId.
5. Fluxo A roda **automático e idempotente** quando vaga é criada.
6. Fluxo B cobre **as duas queries** (cadastro interno + Talentum) e é **idempotente** contra duplicação.

### Não-objetivos

- Webhook ClickUp em tempo real para vagas (decisão registrada em `project_clickup_webhook_out_of_scope`).
- Personalização de copy via Vertex/Gemma (fica como Fase 8 opcional/futura).
- Classificação de respostas inbound do WhatsApp (futuro, fora deste sprint).
- Migração para NestJS / `case-service` (decisão registrada em `project_data_layer_roadmap`).
- Refactor do `MatchmakingService` em si (escopo deste sprint é encadear, não refazer).

---

## 3. Fases

### Fase 0 — Fundação de Observabilidade (PRÉ-REQUISITO BLOQUEANTE)

**Por que primeiro:** se construirmos Fluxo A/B antes, vamos depurar no escuro. Esta fase é estritamente cross-cutting e prepara o terreno.

| # | Item | Arquivos/área | Complexidade |
|---|---|---|---|
| 0.1 | Adicionar `pino` como lib de logging estruturado | `worker-functions/src/shared/logging/Logger.ts` (novo); substituir `console.log/warn/error` críticos | M |
| 0.2 | Middleware Express que extrai `X-Cloud-Trace-Context` (ou gera UUID) e expõe via AsyncLocalStorage | `worker-functions/src/shared/logging/correlationMiddleware.ts` (novo) | M |
| 0.3 | Logger contextual: cada log inclui `traceId, workerId?, jobPostingId?, batchId?` automaticamente | `Logger.ts` consome `AsyncLocalStorage` | M |
| 0.4 | Integrar **error tracking** — DP-001 abaixo decide Sentry vs Cloud Error Reporting | `worker-functions/src/shared/errors/ErrorReporter.ts` (novo) + boot em `src/index.ts` | M |
| 0.5 | Substituir os `catch(() => {})` silenciosos por `errorReporter.capture(err, context)` | `VacancyCrudController:149` (`tryEnsureShortLink`) e outros achados via grep | S |

**Critérios de aceite Fase 0:**
- [ ] Toda request HTTP tem `traceId` único nos logs
- [ ] `pino` em produção emite JSON; em dev emite legível (`pino-pretty`)
- [ ] Cloud Logging consegue filtrar `jsonPayload.traceId = "X"` e ver toda a cadeia
- [ ] Um erro lançado intencionalmente em endpoint de teste aparece no error tracker em <1 min
- [ ] Documentar no `worker-functions/CLAUDE.md` o padrão de uso do logger

---

### Fase 1 — Auditoria de Transições de Status

| # | Item | Arquivos/área | Complexidade |
|---|---|---|---|
| 1.1 | Migration: criar tabela `worker_job_application_stage_history` espelhando `worker_status_history` (colunas: `id, application_id, field_name, old_value, new_value, changed_by, change_source, created_at`) | `worker-functions/migrations/NNN_application_stage_history.sql` | S |
| 1.2 | Trigger `trg_application_stage_history` em `worker_job_applications.application_funnel_stage` | Mesma migration | S |
| 1.3 | Adicionar coluna `batch_id UUID NULL` em `whatsapp_bulk_dispatch_logs` + `messaging_outbox` (para agrupar execuções) | Migration | S |
| 1.4 | Endpoint admin `GET /api/admin/workers/:id/timeline` que retorna union de `worker_status_history` + `worker_job_application_stage_history` + `whatsapp_bulk_dispatch_logs` (filtrado pelo worker) | Novo controller | M |

**Critérios de aceite Fase 1:**
- [ ] Mudança manual de `INVITED → INITIATED` no banco gera linha no history
- [ ] Endpoint `GET /api/admin/workers/:id/timeline` retorna eventos ordenados cronologicamente
- [ ] Logs do trigger ficam visíveis no Cloud Logging com `traceId` quando vier de request

---

### Fase 2 — Log de Envio Manual de WhatsApp

| # | Item | Arquivos/área | Complexidade |
|---|---|---|---|
| 2.1 | `MessagingController.sendToWorker` passa a gravar em `whatsapp_bulk_dispatch_logs` com `triggered_by = userId, batch_id = NULL` (envio individual) | `worker-functions/src/modules/notification/interfaces/controllers/MessagingController.ts` | S |
| 2.2 | Generalizar a tabela ou criar `whatsapp_send_logs` cobrindo qualquer envio (bulk + individual + outbox) — DP-002 abaixo | Migration + refactor | M |
| 2.3 | `OutboxProcessor` também grava no log unificado pós-envio (Twilio SID + delivery_status) | `OutboxProcessor.ts` | S |

**Critérios de aceite Fase 2:**
- [ ] Qualquer envio WhatsApp da plataforma vira uma linha consultável por `worker_id` e `triggered_by`
- [ ] É possível responder "quantos WhatsApps recebeu o AT X nos últimos 30 dias?" com 1 query SQL

---

### Fase 3 — Fluxo A: Convite Automático pós-Match

| # | Item | Arquivos/área | Complexidade |
|---|---|---|---|
| 3.1 | Decidir slug do template — DP-003 (`vacancy_match` reutilizado vs `vacancy_invited_auto` novo) | Decisão antes de código | — |
| 3.2 | Substituir `setImmediate` em `VacancyCrudController:142` por publicação de domain event `vacancy.created` | `VacancyCrudController.ts` + `domain_events` insert | M |
| 3.3 | Handler `VacancyCreatedHandler` registrado em `DomainEventProcessor`: chama `MatchmakingService.matchWorkersForJob` e, pra cada candidato com `application_funnel_stage = 'INVITED'`, enfileira row em `messaging_outbox` com template do passo 3.1 | `worker-functions/src/modules/matching/application/VacancyCreatedHandler.ts` (novo) | M |
| 3.4 | Variables do outbox: `worker_name, vacancy_case_number, distance_km, patient_zone` (vir do `ScoredCandidate`) | Mesmo handler | S |
| 3.5 | Garantir idempotência: se row já existe em `messaging_outbox` com `worker_id+job_posting_id+template_slug` nas últimas 7 dias, não enfileira de novo | Constraint ou check no handler | M |
| 3.6 | Testes E2E: criar vaga → assert outbox cresceu N rows → mock Twilio → assert delivery_status atualiza | `worker-functions/tests/e2e/auto-invite.e2e.ts` | M |

**Critérios de aceite Fase 3:**
- [ ] Criar vaga via API resulta em N convites WhatsApp em <30s (medido)
- [ ] Falha de envio individual não bloqueia os outros (continua processando)
- [ ] Re-criar a mesma vaga não duplica convites
- [ ] Erro no handler vira evento `domain_events.status = 'failed'` + report no error tracker
- [ ] Cada convite é rastreável: query SQL "para vaga X, quais ATs receberam convite, quando, qual delivery_status?"

---

### Fase 4 — Fluxo B (Parte 1): Query Talentum Incompleto

| # | Item | Arquivos/área | Complexidade |
|---|---|---|---|
| 4.1 | Decidir janela de tempo "incompleto há >N dias" — DP-004 | Decisão antes de código | — |
| 4.2 | Criar query `TALENTUM_INCOMPLETE_QUERY`: workers com `application_funnel_stage IN ('INITIATED', 'IN_PROGRESS')` há > N dias, sem mensagem `talentum_reminder` enviada nas últimas M dias | `BulkDispatchTalentumIncompleteUseCase.ts` (novo, paralelo ao existente) | M |
| 4.3 | Template `talentum_incomplete_reminder` em `message_templates` (slug + variables) — DP-005 | Migration | S |
| 4.4 | Endpoint interno `POST /api/internal/bulk-dispatch/talentum-incomplete` consumido por Cloud Scheduler | `InternalController` + routes | S |
| 4.5 | Configurar Cloud Scheduler (fora do código, na infra GCP) — gerar ticket/runbook | Doc separado em `docs/runbooks/` | — |

**Critérios de aceite Fase 4:**
- [ ] Query retorna apenas workers que NÃO receberam o reminder nos últimos M dias
- [ ] Execução manual via endpoint loga `batch_id` e total processado
- [ ] Falha de envio individual gera log com `worker_id` e error reporta

---

### Fase 5 — Fluxo B (Parte 2): Dedup e Idempotência do Bulk Dispatch

| # | Item | Arquivos/área | Complexidade |
|---|---|---|---|
| 5.1 | Adicionar coluna `last_sent_date DATE` em `workers` ou tabela auxiliar `worker_reminder_state` (por template) | Migration | S |
| 5.2 | `BulkDispatchIncompleteWorkersUseCase` e `BulkDispatchTalentumIncompleteUseCase`: skip worker se `last_sent_date = CURRENT_DATE` para aquele template | Refactor dos use cases | M |
| 5.3 | Trasacional: gravar `last_sent_date` ANTES de chamar Twilio (atomic via `SELECT FOR UPDATE` ou `INSERT ... ON CONFLICT DO NOTHING`) | Mesmo lugar | M |
| 5.4 | Cloud Scheduler retry policy: configurar `maxAttempts=1` ou `minBackoff=24h` para confirmar comportamento | Doc runbook | — |
| 5.5 | Testes: rodar bulk dispatch 2x na mesma execução → assert 0 duplicatas | `worker-functions/tests/e2e/bulk-dispatch-dedup.e2e.ts` | S |

**Critérios de aceite Fase 5:**
- [ ] Re-executar o endpoint do cron 5x seguidas resulta em apenas 1 envio por worker no dia
- [ ] Falha do Twilio NÃO marca `last_sent_date` (worker entra na fila do dia seguinte)
- [ ] Race condition entre 2 instâncias do scheduler é resolvida (lock atomico)

---

### Fase 6 — Dashboard de Saúde dos Fluxos (Mínimo Viável)

| # | Item | Arquivos/área | Complexidade |
|---|---|---|---|
| 6.1 | Endpoint admin `GET /api/admin/recruitment/health` retornando: <br>- `auto_invite_last_24h: { vacancies_created, invites_enqueued, invites_sent, invites_delivered, invites_failed }`<br>- `bulk_dispatch_last_run: { batch_id, total, sent, failed, started_at, finished_at }` | Novo controller + queries SQL | M |
| 6.2 | Página simples no admin frontend mostrando esses números (sem chart, só tabela) | `enlite-frontend/src/presentation/pages/admin/RecruitmentHealth.tsx` | M |
| 6.3 | Alerta no Cloud Monitoring: `auto_invite_failed > 5 in 1h` → notifica canal — DP-006 | Infra GCP | — |

**Critérios de aceite Fase 6:**
- [ ] Página carrega em <2s
- [ ] Números batem com queries diretas no banco
- [ ] Falha sintética dispara alerta em <5min

---

### Fase 7 — Documentação e Runbooks

| # | Item | Arquivos/área | Complexidade |
|---|---|---|---|
| 7.1 | `docs/runbooks/RUNBOOK_AUTO_INVITE.md`: o que é o fluxo, como debugar, como replay manual | Doc | S |
| 7.2 | `docs/runbooks/RUNBOOK_BULK_DISPATCH.md`: idem | Doc | S |
| 7.3 | `docs/runbooks/RUNBOOK_OBSERVABILITY.md`: como achar logs por traceId/workerId, onde está error tracker, dashboard URL | Doc | S |
| 7.4 | Atualizar `worker-functions/CLAUDE.md` com padrão de logger contextual e ErrorReporter | Edit | S |
| 7.5 | Mover decisões resolvidas para `docs/FOLLOWUPS.md` (formato DP-NNN) | Edit | S |

**Critérios de aceite Fase 7:**
- [ ] Um novo dev consegue, lendo só o runbook, debugar uma falha de auto-invite simulada
- [ ] FOLLOWUPS.md tem entradas para qualquer débito que ficou pra depois

---

### Fase 8 (OPCIONAL / FUTURO) — Camada de IA para Personalização

**Não é parte do sprint inicial**, mas fica documentado para depois.

- 8.1 Service `MessagePersonalizationService` que chama Vertex/Gemma com contexto (worker profile + vaga + paciente) e retorna copy personalizada
- 8.2 Fallback obrigatório: se LLM falha/timeout, usar template estático
- 8.3 A/B test: 50% personalizado vs 50% template → medir conversion (`INVITED → INITIATED`)
- 8.4 Custo: orçamento mensal de tokens; circuit breaker se exceder
- 8.5 Inbound classifier: ao receber resposta WhatsApp, LLM classifica `interessado | pergunta | não | silencio` e roteia

---

## 4. Decisões Pendentes (DP)

| ID | Decisão | Opções | Recomendação | Quem decide |
|---|---|---|---|---|
| DP-001 | Error tracking: Sentry vs Cloud Error Reporting | (a) Sentry free tier (UI rica, agnóstico); (b) Cloud Error Reporting (já no GCP, sem novo vendor) | **(b)** — minimiza vendor sprawl, integra com Cloud Logging | Gabriel |
| DP-002 | Tabela única `whatsapp_send_logs` vs reutilizar `whatsapp_bulk_dispatch_logs` | (a) Nova tabela genérica; (b) Adicionar `channel`/`source` na atual | **(b)** — menos migração, suficiente | Gabriel |
| DP-003 | Template do convite automático: reusar `vacancy_match` vs criar `vacancy_invited_auto` | (a) Reusar (menos churn); (b) Novo (separa métricas) | **(b)** — pra Fase 6 saber distinguir conversão de auto vs manual | Gabriel + Ops |
| DP-004 | Janela "Talentum incompleto há >N dias" | 3, 5, 7, 14 dias | **5 dias** — equilíbrio entre dar tempo e não esfriar | Ops |
| DP-005 | Cadência do reminder Talentum (envia uma vez ou repete a cada M dias até completar?) | Uma vez / a cada 7 / a cada 14 | **A cada 7 dias, max 3 tentativas** | Ops |
| DP-006 | Threshold do alerta de falha (`auto_invite_failed > N in 1h`) | 5 / 10 / 20 | **5** — começa conservador, afrouxa se ruidoso | Gabriel |
| DP-007 | Aplicar Fase 0 (`pino` + traceId) em **todos** os arquivos ou só nos críticos? | (a) Big-bang; (b) Incremental nos arquivos tocados pelas Fases 1-6 | **(b)** — incremental, reduz blast radius | Gabriel |

---

## 5. Riscos e Mitigações

| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Auto-invite envia spam (vaga criada e descartada várias vezes) | Média | Alto (deteriora número WhatsApp Business) | Dedup do passo 3.5 + alerta de volume anormal Fase 6 |
| Bulk dispatch trava em worker problemático e nunca termina | Baixa | Alto (deixa milhares sem reminder) | Timeout por worker + skip + reportar erro |
| Logging estruturado quebra logs existentes que parsers/scripts consomem | Baixa | Médio | Auditar consumers antes da Fase 0; manter duplo log se necessário |
| Twilio rate limit em bulk dispatch grande (>200 workers) | Média | Médio | Manter delay de 1500ms existente; medir e ajustar |
| Trigger de history degrada performance de update massivo | Baixa | Médio | Benchmark em staging com volume de produção antes de subir |
| Custo do error tracker explode com loop de erros | Baixa | Baixo | Configurar rate limit/sample no SDK |

---

## 6. Resumo de Entregáveis por Fase

| Fase | Migrations | Novos arquivos | Arquivos modificados | Endpoints novos |
|---|---|---|---|---|
| 0 | 0 | 3 (Logger, middleware, ErrorReporter) | ~10 (substituir console.log) | 0 |
| 1 | 1 | 1 (timeline controller) | 0 | 1 (`GET /workers/:id/timeline`) |
| 2 | 0-1 | 0 | 2 (MessagingController, OutboxProcessor) | 0 |
| 3 | 0 | 1 (VacancyCreatedHandler) | 1 (VacancyCrudController) | 0 |
| 4 | 1 (template) | 1 (use case Talentum) | 1 (InternalController) | 1 (`POST /talentum-incomplete`) |
| 5 | 1 (last_sent_date) | 0 | 2 (use cases) | 0 |
| 6 | 0 | 2 (health controller + frontend page) | 0 | 1 (`GET /recruitment/health`) |
| 7 | 0 | 3 runbooks | 2 (CLAUDE.md, FOLLOWUPS.md) | 0 |

**Total estimado:** ~3-4 migrations, ~12 arquivos novos, ~17 modificados, 3 endpoints novos.

---

## 7. Ordem de Execução e Dependências

```
Fase 0 (Observabilidade)
   ↓ (bloqueia tudo)
Fase 1 (Audit history) ──┐
Fase 2 (Log unificado) ──┤
                         ↓
              Fase 3 (Fluxo A) ── Fase 6 (Dashboard) ── Fase 7 (Docs)
                         ↓                ↑
              Fase 4 (Talentum query)     │
                         ↓                │
              Fase 5 (Dedup) ─────────────┘
```

Fases 1 e 2 podem rodar em paralelo após Fase 0. Fases 3 e 4 podem rodar em paralelo após Fase 2.

---

## 8. Critérios Globais de Conclusão do Sprint

- [ ] Toda decisão DP-001 a DP-007 resolvida e movida pra FOLLOWUPS ou documentada
- [ ] Cloud Logging tem busca funcional por `traceId` E por `workerId`
- [ ] Error tracker recebendo eventos de produção (mesmo que zero, está configurado)
- [ ] Fluxo A end-to-end: vaga criada → AT real recebe WhatsApp em <60s (smoke test em staging)
- [ ] Fluxo B end-to-end: cron dispara → ATs incompletos (interno + Talentum) recebem mensagem; re-execução não duplica
- [ ] Dashboard `/recruitment/health` mostra números em produção
- [ ] Runbooks lidos e validados por outro dev
- [ ] Memória atualizada (novos `feedback_*` ou `project_*` conforme aprendizados)

---

## 9. Observações de Design

### Por que NÃO LLM no caminho crítico
Os dois fluxos são **deterministas**. Colocar LLM como decisor adiciona não-determinismo, latência e custo sem ganho de cobertura. Decisão de "quem recebe" deve ser SQL; decisão de "quando" deve ser cron; decisão de "o que enviar" pode ser template estático ou LLM (Fase 8 opcional). Posicionar IA na borda (personalização da copy, classificação de respostas) é o uso defensável; no meio do fluxo, é antipattern.

### Por que Outbox em vez de chamar Twilio direto
- Failure tolerance: se Twilio cair, mensagens ficam pendentes no banco em vez de perder
- Auditoria: estado de cada mensagem é uma linha em banco
- Backpressure: rate limit do Twilio absorvido pelo processor
- Retry: incorporado no padrão (`MAX_ATTEMPTS = 3`)

Toda essa infra já existe em `OutboxProcessor` — o sprint só **liga** os fluxos novos nela.

### Por que `setImmediate` precisa morrer
- Sem persistência: se processo cair entre `setImmediate` e o trabalho, perde
- Sem retry: exceção vira `unhandledRejection`
- Sem tracing: roda fora do contexto da request original
- Sem visibilidade: nenhuma fila pra inspecionar

Trocar por `domain_events` + handler resolve todos os 4 sem reescrever lógica.
