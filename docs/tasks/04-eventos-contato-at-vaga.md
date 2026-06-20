# Task: Sistema de registro de Eventos (Mensagens) de contato AT×Vaga
**ClickUp:** https://app.clickup.com/t/86aj3yug2 · **Status:** Open→Refinada · **Board:** APP Recrutamento

> Subtask de **"Ajustes na Lista de Match das Vacantes"** (`86aj3yuaj`, in review). Ticket **sem descrição** — escopo refinado por PO+Architect e **TRAVADO por Gabriel em 2026-06-19** (ver §9). Doc executável sem perguntas em aberto.

---

## 1. Contexto

A operação de recrutamento contata ATs (workers) candidatos a uma vaga (job_posting) durante o match. Hoje esses contatos acontecem por WhatsApp (Twilio) e por anotações manuais, mas **estão dispersos em várias tabelas e não há uma visão unificada de "o que aconteceu entre este AT e esta vaga"** na tela de Match.

O elo AT×Vaga no modelo é o **`worker_job_applications` (WJA)** — SSOT do funil, com `UNIQUE (worker_id, job_posting_id)` (`worker-functions/migrations/011_create_job_postings_and_applications.sql:58-59,95`). "Contato AT×Vaga" = um evento (mensagem enviada, mudança de etapa, nota manual) escopado a um par WJA.

**Achado central do refino:** quase toda a infraestrutura necessária **já existe**. O que falta é (a) consolidar a leitura por par AT×Vaga e (b) exibir na tela de Match. Detalhes com evidência na §4.

---

## 2. Objetivo

Dar à operadora, na **Lista de Match da vaga**, uma visão cronológica dos **eventos de contato** de um candidato com aquela vaga: mensagens WhatsApp enviadas (+ status de entrega), mudanças de etapa do funil e notas manuais de contato — sem inventar uma nova fonte de verdade nem reimplementar o que já existe.

---

## 3. Escopo (Dentro / Fora)

**Decisão travada (§9): BACKEND + UI no Match.**

### Dentro
- Endpoint de **timeline escopada ao par AT×Vaga** (por `worker_job_application_id`), unindo as fontes que já existem (mensagens, stage history, notas). **WJA-scoped, não worker-scoped global** (§9.6).
- **Exibição** desses eventos na tela de Match (linha do candidato — reusar padrão existente `ContactNotesModal` ou expansão inline de `MatchCandidateRow.tsx:163-171`; escolher o de menor custo com evidência — §9.5).
- **Tipos no MVP:** WHATSAPP + FUNNEL_STAGE + CONTACT_NOTE (§9.3). Entrevistas (`wja.interview_*`) só se trivial, senão v2.
- Reuso das tabelas existentes; **sem schema novo** (§9.4).

### Fora
- **Registro manual de novos tipos de contato (ligação/e-mail) no v1** → portanto **sem coluna/schema novo** (§9.4). Fica para v2.
- **Captura de mensagens inbound** (resposta do AT). Inbound do Twilio vai pro Chatwoot, **não chega no backend** — ver §8. Registrar inbound exigiria integração nova com Chatwoot (outra task).
- Novo canal de mensageria / novo provider.
- Notificação/realtime push de eventos.
- Edição/deleção de eventos (são append-only por natureza de log).
- Timeline cross-vaga no nível worker — **já existe endpoint** (`/api/admin/workers/:id/timeline`) mas é worker-scoped e está fora desta task (que é AT×Vaga); reaproveitar a aba "history" do worker fica para outra task (§9.6).

---

## 4. Estado atual do código — EVIDÊNCIA

### 4.1 Já existe infra de eventos/mensagens? SIM — múltiplas peças

**Mensagens (Mensageria/MSG):**
- `messaging_outbox` — fila de envio. Colunas: `worker_id` NOT NULL (`migrations/060_talent_search_outbox_trigger.sql:8`), `template_slug`, `variables` JSONB, `status`, `attempts`, `error`, `created_at`, `processed_at`, `twilio_sid` (`065:7`), `delivery_status` (`065:8`), `batch_id`, `trace_id`, e **`job_posting_id` NULL** (`migrations/173_add_job_posting_id_to_messaging_outbox.sql:9-10`). Não há `worker_job_application_id`.
- `whatsapp_bulk_dispatch_logs` — log de dispatch/auditoria. Colunas: `worker_id` (`062:8`, depois nullable em `066`), `triggered_by`, `phone`, `template_slug`, `status`, `twilio_sid`, `error_message`, `dispatched_at`, `delivery_status` (`065:14`), `batch_id`, `source` (bulk|individual|outbox, `172:5`), e **`job_posting_id` NULL** (`migrations/181_...:56-58` — adicionado justamente porque a aba "Invitados" vazava status entre vagas).
- `message_templates` — catálogo global por `slug` (`059:5-14` + `content_sid` em `063` + `buttons` em `182`). Sem FK de worker/vaga.
- Twilio status callback: `POST /api/webhooks/twilio/status` atualiza `delivery_status` em ambas as tabelas via `twilio_sid` (`src/modules/notification/interfaces/controllers/TwilioWebhookController.ts:22-84` e o legado `src/interfaces/webhooks/controllers/TwilioWebhookController.ts:22-85`). Status possíveis: sent/delivered/read/undelivered/failed.

**Eventos de domínio (EVT):**
- `domain_events` (transactional outbox, `migrations/099_event_driven_infrastructure.sql:8`). Eventos persistidos hoje: `funnel_stage.qualified`, `funnel_stage.not_qualified`, `funnel_stage.rejected` (`ProcessTalentumPrescreening.ts:264,287,299`), `vacancy.created` (`VacancyCrudController.ts:154`). **NÃO existe evento `message.sent` / `worker.contacted` / `vacancy.invite.sent`** — NÃO ENCONTRADO. O `domain_events` é infra interna assíncrona, não é uma fonte para timeline de UI.

### 4.2 Como mensagens AT×Vaga são registradas HOJE

- Envio individual no Match → `POST /api/admin/messaging/whatsapp/vacancy-match` `{ workerId, jobPostingId }` (`enlite-frontend/src/infrastructure/http/AdminMessagingApiService.ts:42-51`).
- A **única** escrita em `messaging_outbox` que seta `job_posting_id` é o auto-invite pós-match: `src/shared/events/handlers/VacancyAutoInviteHandler.ts:193-205`. Todos os outros INSERTs (lembretes, QualifiedInterview, book-slot) setam só `worker_id`, sem vaga.
- `whatsapp_bulk_dispatch_logs` recebe `job_posting_id` no path de match (mig 181 + `sendVacancyMatch`).
- `worker_job_applications.messaged_at` é carimbado no envio (`migrations/061_add_messaged_at_to_worker_job_applications.sql:8`); é o único sinal persistente exibido hoje no Match (pill "notified {data}", `MatchCandidateRow.tsx:101-105`). `FunnelTableRepository.ts:35,80` lê o dispatch mais recente por (worker, vaga).

### 4.3 "Contato AT×Vaga" no modelo atual — relação via WJA? CONFIRMADO

- WJA é o join AT↔vaga: `worker_id`+`job_posting_id` NOT NULL, `UNIQUE (worker_id, job_posting_id)` (`011:58-59,95`).
- **Já existem DUAS fontes de "eventos de contato" escopadas a WJA:**
  1. **Stage history (auto):** `worker_job_application_stage_history` (`migrations/169_application_stage_history.sql:15-24`), com trigger `fn_log_application_stage_change()` (`:34-59`) que loga toda mudança de `application_funnel_stage` (old→new, changed_by). Indexado `(application_id, created_at DESC)` (`:27`).
  2. **Notas de contato manuais (append-only):** `wja_contact_notes` (`migrations/204_create_wja_contact_notes.sql:1-13`) — FK `worker_job_application_id`, `note_text` (≤240), `created_by_admin_id`, `created_at`. Comment literal: *"Log append-only de notas manuais de contato por operadora, escopadas ao par candidato×vaga (WJA)."* Já tem backend completo (`modules/matching/.../ContactNote*`, `WJAContactNotesController.ts:1-90`) e **UI pronta** (`ContactNotesModal.tsx`) — porém na aba **Funnel**, não no Match.

### 4.4 Timeline/histórico no frontend de match/postulante?

- **No Match: NÃO ENCONTRADO.** `VacancyMatchPage.tsx` não tem timeline/history/notes. Só o pill "notified {data}" por candidato.
- **Endpoint timeline JÁ EXISTE mas worker-scoped:** `GET /api/admin/workers/:id/timeline` (`index.ts:303`, `WorkerTimelineController.ts:88-134`). Faz **UNION de 3 fontes** — `worker_status_history` + `worker_job_application_stage_history` + `whatsapp_bulk_dispatch_logs` — com `kind: status_change | funnel_stage | whatsapp` e paginação. **Zero consumidores no frontend** (`grep /timeline` em `enlite-frontend/src/` = vazio); a aba "history" do worker é um `<PlaceholderTab>` "coming soon" (`WorkerDetailPage.tsx:170-172,183`).

> **Conclusão da §4:** Esta task é ~80% **wiring + escopar por par**, não construção do zero. A query do `WorkerTimelineController` já une exatamente as fontes certas; falta uma variante filtrada por `worker_job_application_id` (par AT×Vaga) e a UI no Match.

---

## 5. Mudanças propostas — reusar vs criar

### Parecer arquitetural: NÃO criar tabela de eventos. Reuso máximo.

Criar uma tabela `worker_vacancy_events` / `contact_events` seria **duplicação injustificada**: os eventos já são persistidos nas tabelas-fonte (mensagens em `whatsapp_bulk_dispatch_logs`/`messaging_outbox`, etapas em `worker_job_application_stage_history`, notas em `wja_contact_notes`). Uma tabela agregadora exigiria sincronização/duplicação e violaria SSOT. O padrão correto — já adotado pelo `WorkerTimelineController` — é **UNION em leitura sobre as fontes existentes**.

### Proposta (em camadas, modular, máx 400 linhas/arquivo)

**Backend (worker-functions):**
1. Novo endpoint **AT×Vaga-scoped**: `GET /api/admin/vacancies/:vacancyId/applications/:wjaId/events` (alinha com a rota de contact-notes já existente, `WJAContactNotesController.ts:11-12`).
2. Reusar/parametrizar a query de UNION do `WorkerTimelineController` numa **query nova filtrada por WJA** (`worker_job_application_id` → resolve worker_id + job_posting_id), unindo as **fontes do MVP** escopadas ao par (§9.3):
   - `worker_job_application_stage_history` (filtra por `application_id = :wjaId`) → `kind: 'funnel_stage'`
   - `whatsapp_bulk_dispatch_logs` (filtra por `worker_id` AND `job_posting_id` do WJA) → `kind: 'whatsapp'` (com `delivery_status`)
   - `messaging_outbox` (mesmo filtro, opcional — cobre envios fora do path bulk) → `kind: 'whatsapp'`
   - `wja_contact_notes` (filtra por `worker_job_application_id`) → `kind: 'contact_note'`
3. Extrair a query SQL/montagem do `TimelineEvent` para um módulo reutilizável (`WJATimelineRepository` / query compartilhada) evitando copy-paste do `WorkerTimelineController` — modularizar.
4. Estender o tipo `TimelineEvent` com `kind: 'contact_note'` e o `delivery_status` da mensagem (já é coluna existente).
8. **Entrevistas (`wja.interview_*`, mig 099/123) — incluir SE TRIVIAL, senão v2** (§9.3). Se for só mais um `SELECT ... UNION` no mesmo repositório (campos `interview_*` já vivem na própria `worker_job_applications`, sem join novo), incluir como `kind: 'interview'`. Se exigir join/lógica extra, deixar para v2 e documentar.

**Frontend (enlite-frontend):**
5. **Decisão de UI travada (§9.5): reusar o padrão existente de menor custo.** Antes de codar, comparar com **evidência file:line** as duas opções e escolher a mais barata:
   - **(A) Modal por linha** estilo `ContactNotesModal.tsx` (aberto de `MatchCandidateRow` `:163-171` ou botão ao lado do "Enviar mensagem" `:139`).
   - **(B) Expansão inline** da `MatchCandidateRow` no ponto de expansão já pronto (`:163-171`).
   Registrar no PR qual foi escolhido e por quê (linhas de código tocadas / componentes reusados). **Proibido** criar um padrão de UI novo do zero.
6. Hook + API client análogos a `useContactNotes` / `AdminContactNotesApiService` → `AdminWjaEventsApiService` chamando o novo endpoint.
7. Render de cada evento por `kind`, enum via i18n (`t('events.kind.WHATSAPP', ...)`), com badge de `delivery_status`.

**Arquivos prováveis (criar/modificar):**
- Criar: `src/modules/matching/infrastructure/WjaTimelineRepository.ts`, `application/ListWjaEventsUseCase.ts`, `interfaces/controllers/WjaEventsController.ts`; rota em `index.ts`.
- Reuso: extrair query comum do `WorkerTimelineController.ts` (refatorar pra compartilhar, sem duplicar).
- Criar frontend: `components/features/admin/VacancyMatch/WjaEventsTimeline.tsx`, `hooks/admin/useWjaEvents.ts`, `infrastructure/http/AdminWjaEventsApiService.ts`.
- Modificar: `MatchCandidateRow.tsx` (gatilho do painel), `VacancyMatchPage.tsx`.

---

## 6. Schema / migrations

**Modelo de evento (de LEITURA, agregado — não é tabela física):**

```
TimelineEvent (AT×Vaga)
  kind            ENUM  FUNNEL_STAGE | WHATSAPP | CONTACT_NOTE   (UPPERCASE EN)
  id              UUID  (id da row na fonte)
  occurred_at     TIMESTAMPTZ
  label           TEXT  (template_slug | field_name | "nota")
  old_value       TEXT? (etapa anterior, p/ funnel_stage)
  new_value       TEXT  (etapa nova | status msg | texto da nota)
  delivery_status TEXT? (sent|delivered|read|undelivered|failed — só whatsapp)
  changed_by      TEXT? (uid operadora / "system")
  source          TEXT? (bulk|individual|outbox)
```

**Migrations necessárias: NENHUMA** (decisão travada §9.2 / §9.4 — sem schema novo no v1). Todas as colunas-fonte já existem (evidência §4). Verificar (não bloqueante, sem migration):
- `whatsapp_bulk_dispatch_logs.job_posting_id` está populado de forma confiável no path de match? (mig 181 sim, mas backfill histórico pode ter NULLs — verificar com DBA).
- Entrevistas (`worker_job_applications.interview_*`, mig 099/123) entram como fonte extra do UNION **só se trivial** (§9.3 / §5 item 8) — ainda sem tabela nova.

> **v2 (fora deste escopo, §9.4):** registro manual de novos tipos de contato (ligação/e-mail) seria o único caso a pedir mudança de schema. Quando for priorizado, estender `wja_contact_notes` com `event_type` (enum UPPERCASE) é preferível a criar tabela nova. **Não fazer no v1.**

---

## 7. Critérios de aceite

1. Dado um candidato na Lista de Match, a operadora vê a lista cronológica (desc) de eventos daquele AT **com aquela vaga**: mensagens WhatsApp (com status de entrega), mudanças de etapa do funil e notas de contato.
2. O endpoint é escopado por `worker_job_application_id` — eventos de **outras vagas do mesmo AT não aparecem** (regressão da mig 181: sem vazamento entre vagas).
3. Nenhuma tabela nova de "eventos" é criada; a leitura é UNION sobre fontes existentes (evidência: diff de migrations vazio ou só aditivo justificado).
4. Cada `kind` renderiza com label via i18n; enum em UPPERCASE EN no backend; `delivery_status` exibido quando aplicável.
5. Paginação (limit/offset) no endpoint, igual ao `WorkerTimelineController`.
6. Mensagens enviadas via Match **aparecem na timeline** após envio (path `vacancy-match` grava em `whatsapp_bulk_dispatch_logs` com `job_posting_id`).
7. **Teste E2E backend** (endpoint) + **teste visual frontend** com `toHaveScreenshot()` do painel de timeline (obrigatório, CLAUDE.md).
8. Arquivos ≤400 linhas; sem `any`.

---

## 8. Riscos & armadilhas

- **Twilio inbound NÃO chega no backend.** Respostas do AT vão pro Chatwoot; `handleOptOut` é letra morta (memória `project_twilio_inbound_chatwoot_optout_dead`). A timeline só pode mostrar eventos **outbound** + etapas + notas. **Não prometer "conversa bidirecional"** — isso é integração Chatwoot, fora de escopo.
- **`job_posting_id` histórico pode ser NULL** em `whatsapp_bulk_dispatch_logs`/`messaging_outbox` para envios anteriores à mig 173/181. Eventos antigos podem não casar com a vaga. Validar com DBA o grau de cobertura; documentar como limitação, não bloqueante.
- **PII de mensagem:** `messaging_outbox.variables` é tokenizado via `messaging_variable_tokens` (mig 086). A timeline deve exibir `template_slug`/status, **não** reidratar variáveis com PII. RBAC futuro governa visibilidade (memória `project_rbac_pii_visibility`) — não hardcodar mascaramento.
- **Volume:** UNION de 3-4 tabelas por par WJA é barato (índices `(application_id, created_at DESC)` em 169 e `(wja, created_at DESC)` em 204 já existem); confirmar índice por `(worker_id, job_posting_id)` em `whatsapp_bulk_dispatch_logs` (mig 181) pra evitar scan.
- **Duplicação de timeline:** `WorkerTimelineController` (worker-scoped) e o novo (WJA-scoped) devem **compartilhar a montagem do evento** — não copiar a query, ou divergem com o tempo.

---

## 9. Decisões TRAVADAS (2026-06-19, Gabriel)

Estas decisões estão **fechadas** — não há perguntas em aberto. Implementar conforme abaixo.

1. **Escopo: BACKEND + UI no Match.** Entregar o endpoint WJA-scoped **E** exibir a timeline de eventos na tela de Match. Não é só log/backend.
2. **NÃO criar tabela nova.** Agregar em leitura o que já existe (`WorkerTimelineController` + `wja_contact_notes` + `messaging_outbox`/`whatsapp_bulk_dispatch_logs`). Parecer arquitetural: **reuso** (UNION em leitura sobre as fontes existentes — §5).
3. **Tipos de evento no MVP:** **WHATSAPP** + **FUNNEL_STAGE** (etapa do funil) + **CONTACT_NOTE**. Entrevistas (`wja.interview_*`) entram **só se custo baixo** — marcar como "incluir se trivial, senão v2" (§5, item 8).
4. **SEM registro manual de contato (ligação/e-mail) no v1** → portanto **SEM coluna/schema novo**. A hipótese de estender `wja_contact_notes` com `event_type` (antiga §6) fica fora do v1.
5. **UI:** **reusar o padrão existente** (`ContactNotesModal` ou expansão inline da `MatchCandidateRow`) — escolher o de **menor custo** e justificar com evidência file:line antes de codar (§5, item 5).
6. **Endpoint WJA-scoped** (par AT×Vaga), **não** worker-scoped global. Filtra por `worker_job_application_id`; reaproveitar a aba "history" do worker (worker-scoped) fica **fora** desta task.

---

## 10. Estimativa & dependências

**Estimativa (MVP TRAVADO §9 = backend WJA-scoped + UI no Match, sem schema novo):**
- Backend (refatorar query compartilhada + endpoint WJA-scoped + use case + E2E): **~1 dia**.
- Frontend (componente timeline + hook + API client + teste visual): **~1-1.5 dia**.
- Total: **~2-2.5 dias** de dev. Baixo risco — reuso pesado de código existente.

**Dependências:**
- Parent **"Ajustes na Lista de Match das Vacantes"** (`86aj3yuaj`) — esta subtask deve casar com as outras mudanças do Match (col status/documentos — task 01).
- Architect deve validar a refatoração compartilhada do `WorkerTimelineController` (não duplicar a query) e justificar a escolha de UI (modal vs inline) com evidência (§9.5).
- Verificação DBA: cobertura de `job_posting_id` em `whatsapp_bulk_dispatch_logs`/`messaging_outbox` (NULLs históricos).

**Pré-condições que JÁ estão satisfeitas (não bloqueiam):** tabelas-fonte, índices, Twilio callback, contact-notes backend+UI, endpoint worker-timeline — tudo existe.
