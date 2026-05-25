# 05 — Fluxo de transições (T1 → T7)

Sete transições cobrem todo o ciclo de vida da WJA, do convite inicial à confirmação da entrevista.

## T1 — Vaga criada + match automático → INVITED

| Campo | Valor |
|---|---|
| **Gatilho** | Domain event `vacancy.created` |
| **Ator** | `VacancyAutoInviteHandler` → `MatchmakingService.saveMatchResults` |
| **Endpoint** | (interno, event-driven) |
| **Pré-condições** | Vaga existe; worker tem perfil ativo com área geográfica compatível; ainda não existe WJA `(worker_id, job_posting_id)` |
| **Pós-condições** | WJA criada com `application_funnel_stage='INVITED'`, `source='talent_search'`; encuadre mínimo criado pelo trigger 189 |
| **Idempotência** | UPSERT com `ON CONFLICT (worker_id, job_posting_id) DO NOTHING`. Segundo disparo é no-op. |

## T2 — Prestador cadastrado clica no link público → INVITED

| Campo | Valor |
|---|---|
| **Gatilho** | HTTP `POST /api/public/vacancies/:id/apply` |
| **Ator** | Worker (auto-serviço) via link distribuído (WordPress, operadoras de recrutamento) |
| **Endpoint** | `WorkerApplicationsController.trackChannel` |
| **Pré-condições** | Worker está cadastrado (`workers` row existe); vaga `id` existe e está aberta |
| **Pós-condições** | WJA com `application_funnel_stage='INVITED'`, `source='manual'`; encuadre mínimo criado pelo trigger 189 |
| **Idempotência** | UPSERT. Se worker já está em stage mais avançado, a precedência canônica bloqueia regressão. |

## T3 — Prestador entra no WhatsApp Talentum → INITIATED

| Campo | Valor |
|---|---|
| **Gatilho** | Webhook Talentum com `action=PRESCREENING_RESPONSE`, `subtype=INITIATED` |
| **Ator** | Sistema Talentum → n8n → `TalentumWebhookController` → `ProcessTalentumPrescreening` |
| **Endpoint** | `POST /api/webhooks/talentum/prescreening` |
| **Pré-condições** | Worker resolvido via email / phone / cuil (auto-cria se não existir); `job_posting_id` resolvido por `ILIKE` em title `"CASO NNN"`; WJA pode ou não existir (auto-cria) |
| **Pós-condições** | `application_funnel_stage='INITIATED'`; registro persistido em `talentum_prescreenings`; encuadre garantido com `origen='Talentum'` (legado) |
| **Idempotência** | Precedência canônica — `INITIATED(1)` sobrescreve `INVITED(0)` mas não regride a partir de stages mais altos. Talentum pode reenviar o mesmo webhook N vezes sem efeito colateral. |

## T4 — Prestador responde 1ª mensagem → IN_PROGRESS

| Campo | Valor |
|---|---|
| **Gatilho** | Webhook Talentum com `subtype=IN_PROGRESS` |
| **Ator** | Sistema Talentum → n8n → `ProcessTalentumPrescreening` |
| **Endpoint** | `POST /api/webhooks/talentum/prescreening` |
| **Pré-condições** | WJA com stage ≤ `IN_PROGRESS` |
| **Pós-condições** | `application_funnel_stage='IN_PROGRESS'` |
| **Idempotência** | Precedência bloqueia regressão; webhook duplicado é no-op |

## T5 — Prestador conclui prescreening → COMPLETED → (QUALIFIED|IN_DOUBT|REJECTED)

T5 acontece em duas etapas, ambas enviadas pelo Talentum:

### T5.a — Conclusão bruta → COMPLETED

| Campo | Valor |
|---|---|
| **Gatilho** | Webhook Talentum com `subtype=COMPLETED` |
| **Pós-condições** | `application_funnel_stage='COMPLETED'` |
| **Idempotência** | Precedência canônica |

### T5.b — Análise → QUALIFIED / IN_DOUBT / REJECTED (auto)

| Campo | Valor |
|---|---|
| **Gatilho** | Webhook Talentum com `subtype=ANALYZED` + `statusLabel` em `{QUALIFIED, IN_DOUBT, NOT_QUALIFIED, PENDING}` |
| **Mapeamento Talentum (transporte interno)** | `TalentumFunnelStageMapper`: QUALIFIED→QUALIFIED, IN_DOUBT→IN_DOUBT, NOT_QUALIFIED→NOT_QUALIFIED, PENDING→ANALYZED |
| **Pós-condições** | `application_funnel_stage` atualizado: QUALIFIED ou IN_DOUBT persistem direto; **NOT_QUALIFIED é auto-rejeitado pra REJECTED na mesma transação** (F3, migration 191 — `ProcessTalentumPrescreening.handleNotQualifiedTransition`); PENDING/ANALYZED pula upsert (transporte interno, nunca persiste em WJA). Se QUALIFIED, emite domain event `funnel_stage.qualified`. Se REJECTED (via NOT_QUALIFIED), emite `funnel_stage.rejected`. |
| **Idempotência** | Precedência canônica; emissão de `funnel_stage.qualified` só ocorre se transição é genuína (`previousStage !== 'QUALIFIED'`); auto-rejeição é guard `previousStage === 'REJECTED'` |

**No Kanban**, COMPLETED + QUALIFIED + IN_DOUBT aparecem na coluna `COMPLETADO` com badges diferenciados. `NOT_QUALIFIED` nunca aparece (auto-vira REJECTED no mesmo webhook — F3). `ANALYZED` nunca persiste em WJA (só em `talentum_prescreenings.status`).

## T6 — QUALIFIED → envio de 3 meet links (sem mudança de stage)

T6 não é transição de stage — é uma **ação automática** disparada pela transição T5.b para `QUALIFIED`.

| Campo | Valor |
|---|---|
| **Gatilho** | Domain event `funnel_stage.qualified` |
| **Ator** | `QualifiedInterviewHandler` |
| **Pré-condições** | Vaga tem ≥1 meet link configurado (`meet_link_1` + `meet_datetime_1`); worker tem telefone resolvido |
| **Pós-condições** | Mensagem WhatsApp interativa enfileirada na `messaging_outbox`; worker recebe até 3 botões; `interview_response='pending'` na WJA |
| **Idempotência** | Domain event só emitido se `previousStage !== 'QUALIFIED'` (T5.b); vaga sem meet links registra warning e não envia (não é erro) |

## T7 — Prestador escolhe slot → CONFIRMED

| Campo | Valor |
|---|---|
| **Gatilho** | Webhook Twilio com `ButtonPayload` em `{slot_1, slot_2, slot_3}` |
| **Ator** | `InboundWhatsAppController` → `BookSlotFromWhatsAppUseCase` |
| **Endpoint** | `POST /api/webhooks/twilio/inbound` |
| **Pré-condições** | Worker identificado por telefone E.164; WJA com `interview_response='pending'`; slot ainda disponível (optimistic lock) |
| **Pós-condições** | `application_funnel_stage='CONFIRMED'`; `interview_meet_link`, `interview_datetime`, `interview_slot_id` salvos em WJA; worker adicionado ao Google Calendar do slot; 2 Cloud Tasks agendadas (lembrete 24h antes + lembrete 5min antes); confirmação enviada via WhatsApp |
| **Idempotência** | `findPendingInterview` valida `interview_response='pending'`; se não estiver, retorna `Result.fail('No pending interview')` sem efeito colateral |

## Transições terminais negativas

### REJECTED (manual)

Admin arrasta card no Kanban para "Rejeitado" (ou fluxo separado). PUT `/api/admin/encuadres/:id/move`. Registra motivo opcional. Não emite domain event.

### REJECTED (auto via NOT_QUALIFIED)

Quando T5.b classifica como `NOT_QUALIFIED`, `ProcessTalentumPrescreening` automaticamente: `application_funnel_stage='REJECTED'`, `encuadres.resultado='RECHAZADO'`, `rejection_reason_category='TALENTUM_NOT_QUALIFIED'`. Emite domain event `funnel_stage.rejected` para auditoria. (Implementado em F3.)

## REPROGRAMAR (re-agendamento da entrevista)

Não é transição de stage canônica — é **edição da WJA existente**. Detalhes em [06-regra-cardinalidade.md](06-regra-cardinalidade.md).
