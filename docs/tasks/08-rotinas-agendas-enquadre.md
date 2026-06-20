# Task: Rotinas automatizadas de Agendas de Enquadre
**ClickUp:** https://app.clickup.com/t/86aj3yva8 · **Status:** Open→Refinada · **Board:** APP Recrutamento

> Ticket criado 2026-06-17 **sem descrição** (confirmado via `getTaskById` 86aj3yva8 — só nome, list `APP Recrutamento`, space `Technology`, sem assignee/comentários). Tudo abaixo é interpretação do PO+Architect a validar (ver §9).

---

## 1. Contexto (enquadre = entrevista matching; WJA é SSOT, encuadres deprecada)

- **Enquadre/Encuadre** = entrevista de matching AT↔paciente (entrevista de seleção do funil). Vocabulário herdado de Talentum/operação.
- **Decisão 2026-05-23 (ADR-003):** `worker_job_applications` (WJA) é o SSOT do funil. A tabela `encuadres` teve campos de funil **deprecados/consolidados** em WJA.
- **ATENÇÃO — a tabela `encuadres` NÃO está morta.** Ela ainda é escrita ativamente:
  - Trigger SQL `trg_ensure_encuadre_on_wja_insert` cria 1 encuadre por WJA inserida — `worker-functions/migrations/189_trigger_ensure_encuadre_on_wja_insert.sql:30-50`
  - `INSERT/UPDATE encuadres` em `ProcessTalentumPrescreening.ts:281,331`, `EncuadreRepository.ts:46,116`, `WorkerApplicationRepository.ts:71`, `WJAFunnelController.ts:247`, `EncuadreQueryRepository.ts:56,126`
  - O que morreu foi o **pipeline reverso** `encuadres → WJA` (`EncuadreRepository.syncToWorkerJobApplications`, F6) — não a tabela.
- **O agendamento da entrevista vive em WJA**, não em encuadres: colunas `interview_datetime`, `interview_response`, `interview_slot_id`, `interview_meet_link`, `interview_reminder_sent_at` em `worker_job_applications` (feature `qualified-interview-flow.md`).

---

## 2. Objetivo

Tornar o agendamento ("agendas") de enquadre uma **rotina automatizada e confiável**, reduzindo trabalho manual e fechando os gaps de cobertura do safety-net atual. Concretamente, a partir da evidência (§4): **ligar a rotina de fallback de lembretes que hoje existe em código mas não tem gatilho, e migrá-la do read da tabela deprecada `encuadres` para o SSOT WJA.**

> **Escopo congelado em 2026-06-19 (§9):** v1 = (1) lembretes safety-net 24h/5min sobre WJA via Cloud Scheduler + (2) transição automática de no-show no funil WJA. Auto-slot e integração de calendário ficam **fora** do v1.

---

## 3. Escopo (Dentro / Fora) — TRAVADO

**v1 = DUAS coisas, ambas lendo de WJA (não de `encuadres`):**

### Dentro — (1) LEMBRETES safety-net
- **Ligar o `ReminderScheduler` órfão** via **Cloud Scheduler**: lembrete **24h** e **5min** antes do enquadre, lendo `interview_datetime` de **`worker_job_applications` (WJA)** — `ReminderScheduler.ts:250` (`processBatch`) está implementado mas sem rota/scheduler (§4).
- Expor a **rota interna** que dispara o batch (`POST /api/internal/reminders/sweep`), espelhando `/outbox/sweep` (`internalRoutes.ts:46`) e `/events/sweep` (`internalRoutes.ts:51`). Hoje só existem `/reminders/qualified` (`internalRoutes.ts:56`) e `/reminders/5min` (`internalRoutes.ts:61`), ambos Cloud Tasks per-booking — **não há `/reminders/sweep`**.
- **Migrar as leituras do batch de `FROM encuadres` para WJA** — alvos: `processEncuadreReminder` (`ReminderScheduler.ts:168`), `process5MinReminder` (`ReminderScheduler.ts:214`), `sendDayBeforeReminders` (`ReminderScheduler.ts:264`), `send5MinReminders` (`ReminderScheduler.ts:307`). O canônico já lê WJA: `processQualifiedInterviewReminder` (`ReminderScheduler.ts:100`, query WJA em `:104-109`) — reusar essa lógica.
- Garantir **idempotência** via flags `*_sent_at` em WJA (§6).

### Dentro — (2) TRANSIÇÃO NO NO-SHOW
- Quando o worker **não comparece / não responde** ao enquadre, **mover/marcar o funil WJA automaticamente**. Regra exata (origem→destino) definida no §9 com evidência dos campos/stages de WJA.
- Hoje **não existe nenhum writer** que faça isso: `no_response` é valor válido de `interview_response` (`migrations/123_reminder_reschedule_flow.sql:18-25`; também `099_event_driven_infrastructure.sql:28-29`) e é estado terminal no `InterviewStateMachine.ts:7,18`, **mas nada o seta** (`GetFunnelTableUseCase.ts:42,50` só lê). Esta task cria o writer.

### Fora (v1)
- **Auto-criação de slots/horários** de enquadre sem ação do admin (hoje slots são criados manualmente — `interview-scheduling.md`).
- **Criar evento no Google Calendar.** O `GoogleCalendarService` já resolve datetime a partir do Meet link pré-existente e adiciona/remove convidado (`GoogleCalendarService.ts:24`, instanciado `startServer.ts:23`) — **sem nova integração**.
- Reviver `encuadres` como fonte de funil (proibido — WJA é SSOT; trigger 189 ainda escreve, mas não é fonte).
- Mudança no fluxo interativo WhatsApp de escolha de slot (já em `qualified-interview-flow.md`).
- Frontend.

---

## 4. Estado atual do código — EVIDÊNCIA

### Como o enquadre é agendado hoje
Fluxo **per-booking, event-driven**, sobre WJA:
- Worker vira `QUALIFIED` (webhook Talentum) → `QualifiedInterviewHandler` enfileira WhatsApp interativo com 3 slots.
- Worker escolhe slot → `BookSlotFromWhatsAppUseCase` grava `interview_datetime/slot_id/response='pending'` em `worker_job_applications` e agenda **2 Cloud Tasks** (24h e 5min antes) via `ReminderScheduler.scheduleReminders()` — `ReminderScheduler.ts:36-65`.
- Cloud Tasks dispara `POST /api/internal/reminders/qualified` e `/5min` → `InternalController.processQualifiedReminder` / `process5MinReminder` (`internalRoutes.ts:56-63`, `InternalController.ts:123,144`).
- Admin também pode criar slots e bookar manualmente: `POST /api/admin/vacancies/:id/interview-slots`, `/interview-slots/:slotId/book` (`interview-scheduling.md`).
- Datas/horas formatadas em UTC: `formatDateUTC/formatTimeUTC` (`ReminderScheduler.ts:131-132`, `dateFormatters.ts:4,14`).

### Existe cron / rotina hoje?
- **Cloud Scheduler existe e é o padrão do projeto** — diretório `worker-functions/gcp/scheduler/`:
  - `sync-patients.yaml` / `sync-vacancies.yaml` (`*/10 * * * *`, tz `America/Argentina/Buenos_Aires`)
  - `bulk-dispatch.yaml` / `bulk-dispatch-talentum.yaml` (`0 13 * * *` = 10h BRT, tz `Etc/UTC`, retry 0, idempotência atômica na app)
- **NÃO existe scheduler para lembretes de entrevista.** `grep` em `worker-functions/gcp/` por `reminders/interview/processBatch` → só acha os dois `bulk-dispatch` (que são cadastro incompleto, não enquadre).
- **`ReminderScheduler.processBatch()` (safety net) existe mas está órfão:** o método está implementado (`ReminderScheduler.ts:250-258`) e o doc o descreve como "Cloud Scheduler" (`ReminderScheduler.ts:21`, `internalReminders.ts` openapi), **mas não há rota** em `internalRoutes.ts` (só `/reminders/qualified` e `/reminders/5min`, ambos Cloud Tasks per-booking) **nem YAML de scheduler** que o chame. Hoje ele é código morto.

### Gap crítico — o batch lê a tabela DEPRECADA
- `processBatch()` → `sendDayBeforeReminders()` / `send5MinReminders()` fazem `FROM encuadres e JOIN interview_slots` (`ReminderScheduler.ts:260-337`).
- `process5MinReminder()` (rota Cloud Tasks ativa!) também lê `FROM encuadres` (`ReminderScheduler.ts:210-244`).
- `processEncuadreReminder()` (fallback do 24h) idem (`ReminderScheduler.ts:164-204`).
- Só `processQualifiedInterviewReminder()` lê WJA (`ReminderScheduler.ts:100-159`). O 24h tenta WJA primeiro e cai pra encuadres; **o 5min NÃO tenta WJA — vai direto pra encuadres** (`ReminderScheduler.ts:210`). Isso é drift de SSOT: o agendamento canônico é WJA, mas parte da rotina lê a tabela deprecada.

### Integração calendário
- **Google Calendar já integrado:** `GoogleCalendarService` (`GoogleCalendarService.ts:24`) — `resolveDateTime` (a partir de Meet link), `addGuestToMeeting`/`removeGuestFromMeeting`. Instanciado em `bootstrap/startServer.ts:23`. Mock via `USE_MOCK_GOOGLE_CALENDAR`, impersonation via `GOOGLE_CALENDAR_IMPERSONATE_EMAIL`. **Não precisa nova integração.**

### Infra reutilizável já pronta
- `CloudTasksClient` (`shared/events/CloudTasksClient.ts`), `PubSubClient`, `messaging_outbox`, `OutboxProcessor`, `internalAuthMiddleware` (OIDC/secret), padrões `/outbox/sweep` + `/events/sweep` (`internalRoutes.ts:46-53`) como **template exato** do sweep de lembretes.

---

## 5. Mudanças (TRAVADO — o quê, onde, reuso de WJA)

### (1) Lembretes safety-net
1. **Rota de sweep** — adicionar em `internalRoutes.ts` (espelhar `/outbox/sweep` em `:46`):
   ```
   router.post('/reminders/sweep', (req, res) => controller.sweepReminders(req, res));
   ```
   `InternalController.sweepReminders` → `reminderScheduler.processBatch()` (`ReminderScheduler.ts:250`). Protegida por `internalAuthMiddleware` (já no router).
2. **Migrar o batch para WJA** — reescrever `processEncuadreReminder` (`:168`), `process5MinReminder` (`:214`), `sendDayBeforeReminders` (`:264`) e `send5MinReminders` (`:307`) para consultar `worker_job_applications` (`interview_datetime`, `interview_response`, `interview_reminder_sent_at`, `interview_reminder_5min_sent_at`, `interview_meet_link`), reusando a query WJA de `processQualifiedInterviewReminder` (`:104-109`). Remover os 4 reads `FROM encuadres` do scheduler.
3. **Cloud Scheduler YAML** — criar `worker-functions/gcp/scheduler/interview-reminders.yaml` (mesmo formato dos existentes em `gcp/scheduler/`): `POST /api/internal/reminders/sweep`, **cadência `*/5 * * * *`** (a cada 5min — granularidade mínima do lembrete 5min), tz `America/Argentina/Buenos_Aires` (alinhar ao `sync-*`; cálculo interno permanece em UTC via `interview_datetime` TIMESTAMPTZ + `formatDateUTC/UTC`), `retryCount: 0` (idempotência atômica na app, padrão `bulk-dispatch`). **Custo:** ~8.640 invocações/mês do sweep; cada invocação é uma query indexada em WJA + envios só dos pendentes. Cloud Scheduler cobra por job (3 jobs grátis/mês no free tier), não por invocação — custo desprezível; o Cloud Run que atende o endpoint escala a zero entre janelas.
4. **Idempotência** — `interview_reminder_sent_at` (24h, já existe — `migrations/099_event_driven_infrastructure.sql:31`) + `interview_reminder_5min_sent_at` (5min, **a criar**, §6). Checar e gravar a flag na mesma operação (sem caminho que pule a checagem).

### (2) Transição no no-show
5. **Writer de no-show** — quando o sweep detecta enquadre passado sem resposta (`interview_response='pending'` e `interview_datetime` < agora − janela de tolerância), aplicar a transição do §9 sobre WJA. Encapsular em um use case dedicado (não inline no scheduler), respeitando `InterviewStateMachine.ts` (`no_response` é terminal — sem reabertura).

### Reuso
6. `CloudTasksClient` (`shared/events/CloudTasksClient.ts`), Pub/Sub, outbox, `internalAuthMiddleware`, padrão sweep e `GoogleCalendarService` já existem. **Sem novas dependências externas.**

> **Limite 400 linhas (regra worker-functions):** `ReminderScheduler.ts` já tem **338 linhas**. Migrar o batch + writer de no-show estoura. **Split obrigatório no mesmo commit** — extrair as queries de WJA para um repositório/módulo dedicado (ex.: `WjaInterviewReminderRepository`) e o writer de no-show para o seu próprio use case. Mencionar o split no commit.

---

## 6. Schema / migrations

### Já existe (WJA — `qualified-interview-flow.md`, migrations 095/099/123)
| Coluna (worker_job_applications) | Uso |
|---|---|
| `interview_datetime` TIMESTAMPTZ | quando ocorre a entrevista (base do cálculo 24h/5min) |
| `interview_response` | `pending/confirmed/declined/awaiting_reschedule/awaiting_reason/no_response` (CHECK mig 123) |
| `interview_slot_id` FK | slot reservado |
| `interview_meet_link` | link Meet |
| `interview_reminder_sent_at` | idempotência do lembrete 24h |
| `interview_decline_reason` | motivo (mig 123) |

`interview_slots` (mig 095): `slot_date/slot_time/slot_end_time/meet_link/max_capacity/booked_count/status`.

### Migration nova (TRAVADA — aditiva, sem drop)
- **Falta flag de idempotência do 5min em WJA.** `interview_reminder_5min_sent_at` está **ABSENT** em WJA (grep nas migrations = 0); hoje a flag do 5min vive só em `encuadres.reminder_5min_sent_at` (`migrations/095...:64`, lida em `ReminderScheduler.ts:241`). A do 24h (`interview_reminder_sent_at`) **já existe** (`migrations/099_event_driven_infrastructure.sql:31`) — não precisa criar.
- **Criar `worker-functions/migrations/216_add_interview_reminder_5min_sent_at.sql`:**
  ```sql
  ALTER TABLE worker_job_applications
    ADD COLUMN IF NOT EXISTS interview_reminder_5min_sent_at TIMESTAMPTZ;
  ```
  Próximo número sequencial confirmado: a maior migration hoje é `215_fix_description_notnull_drift_and_purge.sql` → **216**. Aditiva, idempotente (`IF NOT EXISTS`), sem drop. Aplicar via `scripts/run-migration-prod.sh` (prd manual) + runner Docker no E2E.
- **Sem coluna nova para o no-show:** a transição reusa `interview_response='no_response'` (valor já no CHECK — `migrations/123...:18-25`) e `application_funnel_stage` (valores já no CHECK — `migrations/195_drop_reprogram_funnel_stage.sql:68-82`). Nenhum schema novo além da flag 5min.

---

## 7. Critérios de aceite

### Lembretes
- [ ] Existe Cloud Scheduler job (`gcp/scheduler/interview-reminders.yaml`) chamando `POST /api/internal/reminders/sweep`, autenticado, cadência `*/5 * * * *`, tz `America/Argentina/Buenos_Aires`, `retryCount: 0`.
- [ ] Existe rota `POST /api/internal/reminders/sweep` em `internalRoutes.ts` sob `internalAuthMiddleware`, ligada a `processBatch()`.
- [ ] Todo o batch lê **WJA**, não `encuadres`: `grep "FROM encuadres" ReminderScheduler.ts` (e arquivos extraídos no split) retorna **0**.
- [ ] Rotina **idempotente**: rodar 2× na mesma janela não duplica lembrete — checagem+gravação de `interview_reminder_sent_at` (24h) e `interview_reminder_5min_sent_at` (5min) na mesma operação, com teste provando.
- [ ] Migration `216_add_interview_reminder_5min_sent_at.sql` aplicada (aditiva, `IF NOT EXISTS`).

### No-show
- [ ] Quando `interview_response='pending'` e `interview_datetime` < agora − tolerância, o sweep aplica a transição do §9 sobre WJA: seta `interview_response='no_response'` e move `application_funnel_stage` `CONFIRMED → IN_DOUBT`.
- [ ] A transição é **idempotente** (não reprocessa quem já está `no_response`) e respeita `InterviewStateMachine` (estado terminal, sem reabertura).
- [ ] O writer de no-show vive em use case dedicado, não inline no scheduler.

### Universais
- [ ] Cobertura: unit do batch sobre WJA + unit do writer de no-show + E2E (Docker) cobrindo "lembrete pendente → enviado uma única vez" e "enquadre vencido sem resposta → no_response + stage movido". (Regra: E2E antes do commit.)
- [ ] Nenhum arquivo tocado >400 linhas (`ReminderScheduler.ts` 338 → split obrigatório).
- [ ] Lint + type-check + E2E verdes; nenhum teste pré-existente quebrado.
- [ ] Sem `any`; logs via `@shared/logging` (não `console.*`).

---

## 8. Riscos & armadilhas

- **NÃO reviver encuadres:** a task pode tentar "consertar" o batch mantendo `FROM encuadres`. WJA é SSOT — qualquer leitura de funil/agendamento deve vir de WJA. A tabela `encuadres` continua existindo (trigger 189), mas não é fonte de agendamento.
- **Fuso/horário:** tz do job = `America/Argentina/Buenos_Aires` (alinhado ao `sync-*`); cálculo 24h/5min permanece em UTC (`new Date(...).getTime()`, `formatDateUTC/UTC`). Garantir que o cron e o `interview_datetime` (TIMESTAMPTZ) não desalinhem. **Regra do projeto: fim do dia = 23:59** (nunca 24:00) se algum cálculo de janela usar fim-de-dia.
- **Idempotência da rotina periódica:** com sweep `*/5`, retries e janelas sobrepostas podem reenviar. A flag `*_sent_at` deve ser checada e gravada na mesma operação (`bulk-dispatch` já segue "idempotência atomic na app").
- **Janela de tolerância do no-show:** o gatilho usa `interview_datetime < agora − 30min` (§9). Com sweep a cada 5min, a transição ocorre entre 30 e 35min após o horário — aceitável. Não disparar no-show antes da janela (worker pode chegar atrasado).
- **Duplo gatilho:** Cloud Tasks per-booking + sweep periódico podem disparar o mesmo lembrete. A idempotência (`*_sent_at`) é o que evita — não pode haver caminho que pule a checagem.
- **`ReminderScheduler.ts` já com 338 linhas:** migração tende a estourar 400 → split obrigatório.

---

## 9. Decisões TRAVADAS (2026-06-19, Gabriel)

Nada aqui é mais pergunta. Escopo congelado — implementar como abaixo.

1. **Escopo v1 = lembretes safety-net + transição no no-show.** Nada além disso. (§3)
2. **Auto-slot — FORA.** Admin continua criando slots manualmente.
3. **Lembretes — só 24h e 5min**, lidos de **WJA** (`interview_datetime`), nunca de `encuadres`.
4. **Google Calendar — FORA.** Datetime já resolve do Meet pré-existente (`GoogleCalendarService.ts:24`); sem nova integração.
5. **Transição no no-show — DENTRO.** Regra exata abaixo.
6. **Frequência do 5min = `*/5 * * * *`**, custo registrado em §5.3 (desprezível).

### Regra exata de no-show (origem → destino, com evidência)

**Gatilho:** dentro do `processBatch` (sweep), selecionar WJA com `interview_datetime` no passado além de uma **janela de tolerância** (proposta: **30 min** após o horário) **e** `interview_response = 'pending'` (worker nunca confirmou nem declinou).

**Transição aplicada (atômica, idempotente):**

| Campo | Origem | Destino | Evidência dos valores |
|---|---|---|---|
| `interview_response` | `pending` | `no_response` | CHECK em `migrations/123_reminder_reschedule_flow.sql:18-25` e `099_event_driven_infrastructure.sql:28-29` (`no_response` válido) |
| `application_funnel_stage` | `CONFIRMED` | `IN_DOUBT` | CHECK em `migrations/195_drop_reprogram_funnel_stage.sql:68-82` (ambos válidos) |

**Por quê `CONFIRMED → IN_DOUBT`:** o worker que agendou enquadre está em `CONFIRMED` no funil; não comparecer não é rejeição definitiva (recrutamento ainda pode reprogramar manualmente), então vai para `IN_DOUBT` (não `REJECTED`). `interview_response='no_response'` é terminal no `InterviewStateMachine.ts:7,18` — sem reabertura automática; reprograma é ação manual do admin.

**Guardas:**
- Idempotente: pular quem já está `interview_response='no_response'` (não reprocessar).
- Só aplica a `CONFIRMED`. Se a WJA já saiu de `CONFIRMED` por outra via (`SELECTED`/`REJECTED` manual), **não tocar no stage** — apenas marcar `interview_response='no_response'` se ainda `pending`.
- Sem efeito sobre `encuadres` (não é fonte; trigger 189 segue inalterado).

> Hoje **nenhum código faz essa transição** — `no_response` é valor inerte (`GetFunnelTableUseCase.ts:42,50` só lê). Esta task cria o primeiro writer.

---

## 10. Estimativa & dependências

**Estimativa (escopo §3 "Dentro", v1):** ~2–3 dias.
- Rota sweep + wiring controller: ~0.25d (template `/outbox/sweep` pronto).
- Migrar batch p/ WJA + split do `ReminderScheduler` (>400): ~0.75d.
- Migration aditiva `216_add_interview_reminder_5min_sent_at.sql`: ~0.25d.
- Writer de no-show (use case dedicado): ~0.5d.
- YAML scheduler + deploy/teste manual em stg: ~0.25d.
- Unit + E2E Docker + idempotência (lembretes + no-show): ~0.5d.

**Dependências (escopo já travado em §9 — não bloqueia mais por PO):**
- **Parecer do Architect** (schema: coluna nova em WJA; split de arquivo; novo use case). Obrigatório antes de implementar (CLAUDE.md etapa 2).
- Provisionamento do Cloud Scheduler job em `enlite-prd`/`enlite-stg` (prd ainda manual via `gcloud`).
- Templates WhatsApp já existem (`qualified_reminder_*`, mig 123) — sem dependência de aprovação nova se reusar.

---

### Evidência (resumo dos greps/reads)
- Ticket sem descrição: `getTaskById(86aj3yva8)`.
- `encuadres` vivo: `migrations/189...sql:30-50`; writes em `ProcessTalentumPrescreening.ts:281,331`, `EncuadreRepository.ts:46,116`.
- Agendamento em WJA: `qualified-interview-flow.md`; colunas mig 095/099/123.
- Cron existe, mas não p/ enquadre: `gcp/scheduler/{sync-*,bulk-dispatch*}.yaml`; `grep gcp/` por reminders → 0.
- `processBatch` órfão: implementado `ReminderScheduler.ts:250-258`; sem rota em `internalRoutes.ts:10-76`; doc o chama "Cloud Scheduler" (`internalReminders.ts` openapi).
- Batch/5min leem tabela deprecada: `ReminderScheduler.ts:210,260-337` (`FROM encuadres`).
- Google Calendar já integrado: `GoogleCalendarService.ts:24`, `startServer.ts:23`.
- Tamanho: `ReminderScheduler.ts` = 338 linhas (`wc -l`).
