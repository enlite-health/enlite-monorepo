# 08 — Pipelines de escrita

Inventário dos caminhos que **gravam** em `worker_job_applications` ou `encuadres`. Cada pipeline tem responsabilidade única e bem definida. Pipelines deprecados não devem ser invocados em código novo.

## Pipelines ativos (7)

### 1. Talentum webhook → WJA

| Item | Valor |
|---|---|
| **Endpoint** | `POST /api/webhooks/talentum/prescreening` |
| **Controller** | `TalentumWebhookController` |
| **Use case** | `ProcessTalentumPrescreening` |
| **Auth** | Google ID Token (OAuth2Client, n8n → Cloud Function) |
| **Gerencia** | T3 (INITIATED), T4 (IN_PROGRESS), T5.a (COMPLETED), T5.b (QUALIFIED / IN_DOUBT / NOT_QUALIFIED) |
| **Escreve em** | `worker_job_applications` (stage, `source='talentum'`), `talentum_prescreenings`, `talentum_prescreening_responses`, `encuadres` (via `ensureEncuadre`, registro mínimo + `import_source_audit='Talentum'` — F8 renomeou de `origen` via migration 197) |
| **Emite eventos** | `funnel_stage.qualified`, `funnel_stage.rejected` (após F3) |

### 2. Matchmaking automático → WJA INVITED

| Item | Valor |
|---|---|
| **Trigger** | Domain event `vacancy.created` |
| **Handler** | `VacancyAutoInviteHandler` |
| **Service** | `MatchmakingService.matchWorkersForJob` → `saveMatchResults` |
| **Gerencia** | T1 |
| **Escreve em** | `worker_job_applications` (stage=INVITED, `source='system'`, `acquisition_channel='system'` — F7.c: antes era `source='talent_search'` + acquisition_channel NULL); `messaging_outbox` (template `ar_vacancy_match_complete` ou `ar_vacancy_match_incomplete`) |
| **Idempotência** | UPSERT `ON CONFLICT (worker_id, job_posting_id) DO NOTHING` |

### 3. Self-service via link público → WJA INVITED

| Item | Valor |
|---|---|
| **Endpoint** | `POST /api/public/vacancies/:id/apply` |
| **Controller** | `WorkerApplicationsController.trackChannel` |
| **Gerencia** | T2 |
| **Escreve em** | `worker_job_applications` (stage=INVITED, `source='manual'`, `acquisition_channel` derivado de query param: `facebook` / `instagram` / `whatsapp` / `linkedin` / `site` ou NULL); `encuadres` via trigger 189 |
| **Idempotência** | UPSERT respeita precedência; se WJA já existe em stage superior, não regride |

### 4. Trigger SQL — invariante encuadre↔WJA

| Item | Valor |
|---|---|
| **Migration** | 189 (`trg_ensure_encuadre_on_wja_insert`), atualizada em 193 (F5) |
| **Disparo** | AFTER INSERT em `worker_job_applications` |
| **Escreve em** | `encuadres` (registro mínimo se não existir, `import_source_audit='auto-trigger'` — F8 renomeou de `origen`; **`ON CONFLICT (worker_id, job_posting_id) DO NOTHING`** após F5/F8 — antes era `ON CONFLICT (dedup_hash)`) |
| **Propósito** | Garantir invariante 1:1 entre WJA e encuadre sem exigir que cada call site crie encuadre manualmente. Após migration 193 em prod, trigger usa par composto pra alinhar com UNIQUE composta de F5. |

### 5. Drag manual no Kanban — admin override

| Item | Valor |
|---|---|
| **Endpoint** | `PUT /api/admin/encuadres/:id/move` (path mantido com nome legado por decisão fixada — sem breaking change na API) |
| **Controller** | `EncuadreFunnelController.moveEncuadre` (após F7.a renomeia pra `WJAFunnelController.moveEncuadre` — endpoint não muda) |
| **Escreve em** | `worker_job_applications` (stage manual); `encuadres.resultado` como efeito colateral em estados terminais (SELECTED → SELECCIONADO, REJECTED → RECHAZADO); `worker_job_application_stage_history` |
| **Pode regredir stage** | Sim — drag manual é a única operação que pode contrariar a precedência canônica. Registra em `stage_history` com `reason='ADMIN_DRAG'`. |
| **Drag rules** | Não droppable em INITIATED/IN_PROGRESS/COMPLETADO (controle Talentum). Droppable em INVITADO/CONFIRMADO/SELECTED/REJECTED (F4). |

### 6. Booking de slot via WhatsApp — QUALIFIED → CONFIRMED

| Item | Valor |
|---|---|
| **Endpoint** | `POST /api/webhooks/twilio/inbound` |
| **Controller** | `InboundWhatsAppController` |
| **Use case** | `BookSlotFromWhatsAppUseCase` |
| **Gerencia** | T7 |
| **Escreve em** | `worker_job_applications` (stage=CONFIRMED, interview_meet_link, interview_datetime, interview_slot_id, interview_response=confirmed); `interview_slots.booked_count++`; `messaging_outbox` (confirmação WhatsApp) |
| **Side effects** | Adiciona worker ao Google Calendar do slot; agenda 2 Cloud Tasks (lembrete 24h + 5min) |

### 7. Reschedule via WhatsApp reminder — F7.b (REPROGRAMAR)

| Item | Valor |
|---|---|
| **Endpoint** | `POST /api/webhooks/twilio/inbound` (mesmo endpoint do T7, diferentes payloads) |
| **Controller** | `InboundWhatsAppController` |
| **Use case** | `HandleReminderResponseUseCase.handleRescheduleYes` |
| **Gerencia** | T7.b (REPROGRAMAR — re-agendamento via reminder) |
| **Escreve em** | `worker_job_applications` (**stage permanece CONFIRMED**, `interview_response='awaiting_reschedule'`, `interview_meet_link=NULL`, `interview_datetime=NULL`, `interview_slot_id=NULL`); `interview_slots.booked_count--` (libera slot); `messaging_outbox` (template `qualified_reprogram_confirm`) |
| **State machine** | `InterviewStateMachine`: `awaiting_reschedule → awaiting_reschedule` (self-loop idempotente — múltiplos cliques OK) |
| **Sem fluxo automático** | Admin precisa reenviar links manualmente (não há automação de reagendamento — TD-006 do POSTMORTEM) |
| **Decisão arquitetural** | ADR-003 seção F7.b (Opção C escolhida: CONFIRMED + flag, evita perder semântica do funil) |

## Pipelines deprecados (3) — NÃO USAR

### D1. `EncuadreRepository.syncToWorkerJobApplications`

| Item | Valor |
|---|---|
| **Status** | Deprecado em **F6 (commit `616ff1c`)** — função mantida com JSDoc `@deprecated`; chamada removida do único call site ativo (`scripts/import-encuadres-from-clickup.ts`) |
| **Histórico** | Lia `encuadres.resultado` e atualizava `worker_job_applications.application_funnel_stage` |
| **Problema** | Constituía pipeline reverso, conflitando com WJA como SSOT do stage. Discovery DBA F6 detectou 19k inconsistências de stage acumuladas — user aceitou como histórico. |
| **Substituto** | Stage flui sempre **de** Talentum/matchmaking/self-service/drag **para** WJA. Nunca de encuadre para WJA. |
| **Backfill manual permitido?** | Sim, função preservada pra rodar uma vez se necessário (com aprovação do PO) |

### D2. Importação de planilha operativa via `import-encuadres-from-clickup.ts`

| Item | Valor |
|---|---|
| **Status** | **MITIGADO mas não fechado.** F6 adicionou guard hard no script (commit `c678efb`): execução `--live` requer `I_UNDERSTAND_F6_DEPRECATION=true` |
| **Histórico** | Importava ClickUp/CSV/XLSX da planilha operacional para `encuadres` com `origen='planilla_operativa'` |
| **Achado crítico (Discovery F6)** | User declarou "planilha morreu em 2026-05-23". DBA mostrou escrita em **2026-05-21** (3 dias antes da decisão). 8.975 WJAs vêm dessa source. Script ainda era disparado de **algum lugar fora do versionamento** (Cloud Scheduler não-IaC, cron SO, n8n não-versionado, ou operador manual). |
| **Mitigação ativa** | Guard hard no script aborta `--live` por padrão. Cron/automação quebra ruidosamente; operador manual precisa override consciente. |
| **Bloqueador residual** | **TD-047** — investigar quem dispara (checklist gcloud + SSH + n8n + Slack em `docs/FOLLOWUPS.md`). F6 efetivamente concluída em prod só após TD-047 fechado. |
| **Substituto** | Dados de candidatura entram via Talentum webhook ou matchmaking interno |

### D3. `ReminderScheduler.processEncuadreReminder`

| Item | Valor |
|---|---|
| **Status** | Legado. Aguardando confirmação de descontinuação antes de remoção. |
| **Histórico** | Disparava lembretes baseado em `encuadres.interview_slot_id`, `reminder_day_sent_at`, `reminder_5min_sent_at` |
| **Problema** | Usa campos deprecados de `encuadres`. Substituído pelo fluxo Cloud Tasks agendado em T7. |
| **Substituto** | Lembretes são agendados via Cloud Tasks no momento do booking (T7). |

## Princípios gerais para pipelines novos

1. **Escrever apenas em `worker_job_applications`.** Para criar encuadre mínimo, deixe o trigger 189 cuidar.
2. **Respeitar precedência canônica.** Use UPSERT que compara `funnel_stage_precedence` antes de atualizar stage.
3. **Registrar transições em `stage_history`.** Inclua `reason` descritiva.
4. **Emitir domain events para transições significativas** (qualified, rejected, confirmed). Outras camadas consomem via outbox.
5. **Nunca criar pipeline reverso.** Se você está pensando em ler de uma tabela B e atualizar uma tabela A com base nisso, repense — provavelmente A deve ser SSOT e B deve consumir A.
6. **Toda WJA tem encuadre garantido (trigger 189).** Não precisa criar encuadre manualmente em código novo.
