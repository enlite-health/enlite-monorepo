# 08 — Pipelines de escrita

Inventário dos caminhos que **gravam** em `worker_job_applications` ou `encuadres`. Cada pipeline tem responsabilidade única e bem definida. Pipelines deprecados não devem ser invocados em código novo.

## Pipelines ativos (6)

### 1. Talentum webhook → WJA

| Item | Valor |
|---|---|
| **Endpoint** | `POST /api/webhooks/talentum/prescreening` |
| **Controller** | `TalentumWebhookController` |
| **Use case** | `ProcessTalentumPrescreening` |
| **Auth** | Google ID Token (OAuth2Client, n8n → Cloud Function) |
| **Gerencia** | T3 (INITIATED), T4 (IN_PROGRESS), T5.a (COMPLETED), T5.b (QUALIFIED / IN_DOUBT / NOT_QUALIFIED) |
| **Escreve em** | `worker_job_applications` (stage), `talentum_prescreenings`, `talentum_prescreening_responses`, `encuadres` (via `ensureEncuadre`, apenas registro mínimo + `origen='Talentum'`) |
| **Emite eventos** | `funnel_stage.qualified`, `funnel_stage.rejected` (após F3) |

### 2. Matchmaking automático → WJA INVITED

| Item | Valor |
|---|---|
| **Trigger** | Domain event `vacancy.created` |
| **Handler** | `VacancyAutoInviteHandler` |
| **Service** | `MatchmakingService.matchWorkersForJob` → `saveMatchResults` |
| **Gerencia** | T1 |
| **Escreve em** | `worker_job_applications` (stage=INVITED, source=talent_search); `messaging_outbox` (template `ar_vacancy_match_complete` ou `ar_vacancy_match_incomplete`) |
| **Idempotência** | UPSERT `ON CONFLICT (worker_id, job_posting_id) DO NOTHING` |

### 3. Self-service via link público → WJA INVITED

| Item | Valor |
|---|---|
| **Endpoint** | `POST /api/public/vacancies/:id/apply` |
| **Controller** | `WorkerApplicationsController.trackChannel` |
| **Gerencia** | T2 |
| **Escreve em** | `worker_job_applications` (stage=INVITED, source=manual) |
| **Idempotência** | UPSERT respeita precedência; se WJA já existe em stage superior, não regride |

### 4. Trigger SQL — invariante encuadre↔WJA

| Item | Valor |
|---|---|
| **Migration** | 189 (`trg_ensure_encuadre_on_wja_insert`) |
| **Disparo** | AFTER INSERT em `worker_job_applications` |
| **Escreve em** | `encuadres` (registro mínimo se não existir, `origen='auto-trigger'`, `ON CONFLICT (dedup_hash) DO NOTHING`) |
| **Propósito** | Garantir invariante 1:1 entre WJA e encuadre sem exigir que cada call site crie encuadre manualmente |

### 5. Drag manual no Kanban — admin override

| Item | Valor |
|---|---|
| **Endpoint** | `PUT /api/admin/encuadres/:id/move` |
| **Controller** | `EncuadreFunnelController.moveEncuadre` |
| **Escreve em** | `worker_job_applications` (stage manual); `encuadres.resultado` como efeito colateral em estados terminais (SELECTED → SELECCIONADO, REJECTED → RECHAZADO); `worker_job_application_stage_history` |
| **Pode regredir stage** | Sim — drag manual é a única operação que pode contrariar a precedência canônica. Registra em `stage_history` com `reason='ADMIN_DRAG'`. |

### 6. Booking de slot via WhatsApp — QUALIFIED → CONFIRMED

| Item | Valor |
|---|---|
| **Endpoint** | `POST /api/webhooks/twilio/inbound` |
| **Controller** | `InboundWhatsAppController` |
| **Use case** | `BookSlotFromWhatsAppUseCase` |
| **Gerencia** | T7 |
| **Escreve em** | `worker_job_applications` (stage=CONFIRMED, interview_meet_link, interview_datetime, interview_slot_id, interview_response=confirmed); `interview_slots.booked_count++`; `messaging_outbox` (confirmação WhatsApp) |
| **Side effects** | Adiciona worker ao Google Calendar do slot; agenda 2 Cloud Tasks (lembrete 24h + 5min) |

## Pipelines deprecados (3) — NÃO USAR

### D1. `EncuadreRepository.syncToWorkerJobApplications`

| Item | Valor |
|---|---|
| **Status** | Deprecado em F6 — vira backfill one-shot, removido da "sequência obrigatória pós-import" |
| **Histórico** | Lia `encuadres.resultado` e atualizava `worker_job_applications.application_funnel_stage` |
| **Problema** | Constituía pipeline reverso, conflitando com WJA como SSOT do stage |
| **Substituto** | Stage flui sempre **de** Talentum/matchmaking/self-service/drag **para** WJA. Nunca de encuadre para WJA. |

### D2. Importação de planilha operativa

| Item | Valor |
|---|---|
| **Status** | Morta. Confirmado por Gabriel em 2026-05-23. |
| **Histórico** | Importava CSV/XLSX da planilha operacional para `encuadres` com `origen='planilla_operativa'` |
| **Problema** | Fonte original do `encuadres.interview_date/time/meet_link` e da fragmentação de SSOT |
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
