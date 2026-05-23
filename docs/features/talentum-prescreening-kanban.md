# Talentum Prescreening (pipeline de origem)

> Para o modelo canônico do funil/Kanban ver [features/worker-job-applications/](worker-job-applications/README.md). Este doc cobre apenas a integração Talentum → ProcessTalentumPrescreening.

> Fluxo completo: webhook Talentum -> persistencia -> sincronizacao com funil -> visualizacao Kanban com polling.

**Atualizado em:** 2026-04-08

---

## Visao geral

O Talentum e um parceiro externo que aplica prescreenings (questionarios automatizados via WhatsApp) a candidatos de vagas Enlite. O fluxo cobre desde o recebimento do webhook ate a visualizacao do progresso em tempo real no Kanban.

```
Talentum (WhatsApp bot)
  |
  v
n8n (intermediario)
  |
  v
POST /api/webhooks/talentum/prescreening
  |
  v
TalentumWebhookController (discriminated union por action)
  |
  +-- action: PRESCREENING        -> VacancyCreatedHandler (notificacao de vaga aberta)
  +-- action: PRESCREENING_RESPONSE -> PrescreeningResponseHandler -> ProcessTalentumPrescreening
        |
        v
      1. Resolver worker (email -> phone -> cuil -> auto-create)
      2. Resolver job_posting (ILIKE em title com "CASO NNN")
      3. Persistir prescreening (upsert talentum_prescreenings)
      4. Sincronizar funil (upsert worker_job_applications — encuadre é nome operacional para a mesma WJA)
      5. Persistir perguntas e respostas
        |
        v
      Kanban atualiza automaticamente (polling 5s)
```

---

## Webhook — Payload e variantes

O webhook usa discriminated union pelo campo `action`:

### Variante 1: `PRESCREENING` (subtype: `CREATED`)

Notifica criacao de prescreening no Talentum. Nao gera dados de candidato.

```json
{ "action": "PRESCREENING", "subtype": "CREATED", "data": { "_id": "...", "name": "CASO 747" } }
```

### Variante 2: `PRESCREENING_RESPONSE` (subtype: status do candidato)

Enviada a cada progresso do candidato. Comportamento **incremental** — cada POST contem o objeto completo acumulado.

```json
{
  "action": "PRESCREENING_RESPONSE",
  "subtype": "INITIATED | IN_PROGRESS | COMPLETED | ANALYZED",
  "data": {
    "prescreening": { "id": "ext-id", "name": "CASO 747" },
    "profile": {
      "id": "profile-id",
      "firstName": "...", "lastName": "...",
      "email": "...", "phoneNumber": "...", "cuil": "...",
      "registerQuestions": [{ "questionId": "...", "question": "...", "answer": "..." }]
    },
    "response": {
      "id": "...",
      "state": [{ "questionId": "...", "question": "...", "answer": "..." }],
      "score": 85.5,
      "statusLabel": "QUALIFIED | NOT_QUALIFIED | IN_DOUBT | PENDING"
    }
  }
}
```

**`subtype`** indica o status do processo:
- `INITIATED` — candidato clicou no link, entrou no WhatsApp
- `IN_PROGRESS` — respondeu pelo menos 1 pergunta
- `COMPLETED` — respondeu todas as perguntas
- `ANALYZED` — Talentum avaliou e atribuiu `statusLabel` + `score`

**`statusLabel`** (so em `ANALYZED`): `QUALIFIED`, `NOT_QUALIFIED`, `IN_DOUBT`, `PENDING`

---

## Modelo de dados

### 3 tabelas dedicadas

```
talentum_prescreenings           -> 1 registro por candidato x vaga (dedup: prescreening_id + profile_id)
talentum_questions               -> catalogo deduplicado de perguntas (dedup: question_id)
talentum_prescreening_responses  -> respostas: N por prescreening, uma por (prescreening, question, source)
```

### talentum_prescreenings

| Coluna | Tipo | Notas |
|--------|------|-------|
| id | UUID PK | |
| talentum_prescreening_id | VARCHAR(255) | ID externo do Talentum |
| talentum_profile_id | VARCHAR(255) | ID do perfil no Talentum |
| worker_id | UUID FK -> workers | Resolvido por lookup |
| job_posting_id | UUID FK -> job_postings | Resolvido por ILIKE em title |
| job_case_name | TEXT | Nome bruto do caso (auditoria) |
| status | VARCHAR(50) | INITIATED, IN_PROGRESS, COMPLETED, ANALYZED |
| environment | VARCHAR(20) | production ou test |
| created_at / updated_at | TIMESTAMPTZ | |

**Constraint UNIQUE:** `(talentum_prescreening_id, talentum_profile_id)` — chave composta.
Permite que o mesmo prescreening tenha candidatos diferentes (profiles distintos).

**Estrategia ON CONFLICT:**
```sql
ON CONFLICT (talentum_prescreening_id, talentum_profile_id) DO UPDATE SET
  status = EXCLUDED.status,
  worker_id = COALESCE(existing.worker_id, EXCLUDED.worker_id),
  job_posting_id = COALESCE(existing.job_posting_id, EXCLUDED.job_posting_id),
  environment = EXCLUDED.environment,
  updated_at = NOW()
```

### talentum_questions

Catalogo deduplicado. Texto e tipo sobrescritos no upsert (podem mudar no Talentum).

### talentum_prescreening_responses

Respostas por prescreening. `response_source` discrimina `register` (cadastro) de `prescreening` (vaga).

---

## Use case: ProcessTalentumPrescreening

**Arquivo:** `worker-functions/src/application/usecases/ProcessTalentumPrescreening.ts`

### Sequencia de operacoes

```
1. resolveOrCreateWorker(payload)
   |  Busca: email -> phone -> cuil (via IWorkerLookup)
   |  Se nao encontrou: auto-cria worker com status INCOMPLETE_REGISTER
   |  INVARIANTE: worker_id SEMPRE deve ser resolvido (candidato ja tem cadastro na plataforma)
   v
2. resolveJobPosting(prescreening.name)
   |  Extrai "CASO NNN" via regex
   |  Busca job_posting por ILIKE em title
   |  INVARIANTE: job_posting_id SEMPRE deve ser resolvido (vaga ja existe)
   v
3. persistPrescreening(payload, workerId, jobPostingId)
   |  Upsert em talentum_prescreenings
   v
4. syncFunnelAndEncuadre(prescreening, payload)
   |  4a. deriveFunnelStage: subtype direto, ou statusLabel se ANALYZED
   |  4b. upsertWorkerJobApplicationFromTalentum (se stage != ANALYZED sem label)
   |      -> Atualiza application_funnel_stage (fonte de verdade do Kanban)
   |      -> Detecta transicoes QUALIFIED e NOT_QUALIFIED
   |  4c. ensureEncuadre (cria encuadre se nao existe)
   |      -> dedup_hash = md5("talentum|{prescreening.id}|{profile.id}")
   v
5. persistQuestions(prescreeningId, payload)
   |  Upsert perguntas + respostas (register + prescreening)
   v
6. Retorna resultado (prescreeningId, workerId, jobPostingId, resolved)
```

### Derivacao do funnel stage

```typescript
if (subtype === 'ANALYZED' && statusLabel existe)
  -> retorna statusLabel (QUALIFIED, NOT_QUALIFIED, IN_DOUBT, PENDING)
else
  -> retorna subtype (INITIATED, IN_PROGRESS, COMPLETED, ANALYZED)
```

### Transicoes automaticas

| Transicao | Efeito |
|-----------|--------|
| -> QUALIFIED | Domain event `funnel_stage.qualified` + Pub/Sub (dispara fluxo de entrevista) |
| -> NOT_QUALIFIED | Encuadre marcado `resultado = RECHAZADO`, `rejection_reason_category = TALENTUM_NOT_QUALIFIED` + domain event |

---

## Sincronizacao com o funil (worker_job_applications)

A tabela `worker_job_applications` e a **fonte de verdade** para o estagio do candidato no funil de selecao.

**Metodo:** `upsertWorkerJobApplicationFromTalentum`
**Arquivo:** `worker-functions/src/infrastructure/repositories/TalentumPrescreeningRepository.ts`

```sql
INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, match_score, application_status, source)
VALUES ($1, $2, $3, $4, 'applied', 'talentum')
ON CONFLICT (worker_id, job_posting_id) DO UPDATE SET
  application_funnel_stage = EXCLUDED.application_funnel_stage,  -- sempre sobrescreve
  match_score = EXCLUDED.match_score,                            -- sempre sobrescreve
  source = COALESCE(NULLIF(existing.source, 'manual'), EXCLUDED.source)
```

O Talentum e a fonte de verdade para `application_funnel_stage` — sempre sobrescreve.

---

## Kanban — ver doc canônico

O Kanban opera diretamente sobre `worker_job_applications`. Ver [04-estados-funil-kanban.md](worker-job-applications/04-estados-funil-kanban.md) e [08-pipelines.md](worker-job-applications/08-pipelines.md).

---

## Mover encuadre no Kanban (drag-and-drop)

**Endpoint:** `PUT /api/admin/encuadres/:id/move`
**Body:** `{ targetStage, rejectionReasonCategory?, rejectionReason? }`

Stages validos para mover: `INITIATED, IN_PROGRESS, COMPLETED, QUALIFIED, IN_DOUBT, NOT_QUALIFIED, CONFIRMED, REJECTED`

> Nota: lista será reduzida em F2+F7; ver [02-vocabulario.md](worker-job-applications/02-vocabulario.md).

Efeitos colaterais:
- `SELECTED` -> atualiza `encuadre.resultado = 'SELECCIONADO'`
- `REJECTED` -> atualiza `encuadre.resultado = 'RECHAZADO'` + motivo

---

## Arquivos-chave

### Backend (worker-functions)

| Arquivo | Responsabilidade |
|---------|-----------------|
| `src/interfaces/webhooks/controllers/TalentumWebhookController.ts` | Dispatch por action |
| `src/interfaces/webhooks/handlers/PrescreeningResponseHandler.ts` | Handler PRESCREENING_RESPONSE |
| `src/interfaces/webhooks/handlers/VacancyCreatedHandler.ts` | Handler PRESCREENING.CREATED |
| `src/interfaces/webhooks/validators/talentumPrescreeningSchema.ts` | Zod schema (discriminated union) |
| `src/application/usecases/ProcessTalentumPrescreening.ts` | Use case principal |
| `src/infrastructure/repositories/TalentumPrescreeningRepository.ts` | Persistencia (3 tabelas + WJA) |
| `src/domain/entities/TalentumPrescreening.ts` | Entidades e DTOs |
| `src/interfaces/controllers/EncuadreFunnelController.ts` | API do Kanban + move encuadre |

### Frontend (enlite-frontend)

| Arquivo | Responsabilidade |
|---------|-----------------|
| `src/presentation/pages/admin/VacancyKanbanPage.tsx` | Pagina do Kanban |
| `src/presentation/components/features/admin/Kanban/KanbanBoard.tsx` | Board com 7 colunas + drag-and-drop |
| `src/presentation/components/features/admin/Kanban/KanbanCard.tsx` | Card com badge Talentum |
| `src/hooks/admin/useEncuadreFunnel.ts` | Hook com polling 5s |
| `src/infrastructure/http/AdminApiService.ts` | API client |

### Migrations

| Migration | O que faz |
|-----------|-----------|
| `057_add_talentum_prescreening_tables.sql` | Cria 3 tabelas + indices |
| `093_add_environment_to_prescreenings.sql` | Adiciona coluna environment |
| `117_add_talentum_not_qualified_rejection_category.sql` | Adiciona categoria de rejeicao |

---

## Invariantes de negocio

1. **worker_id SEMPRE preenchido** — candidato so entra no Talentum se ja tem cadastro na plataforma
2. **job_posting_id SEMPRE preenchido** — vaga e criada antes de ativar o prescreening
3. **Transicao para QUALIFIED e exclusiva do webhook Talentum** — nunca manual
4. **NOT_QUALIFIED auto-rejeita o encuadre** com `TALENTUM_NOT_QUALIFIED`
5. **Sem encuadre = invisivel no Kanban** — o encuadre DEVE ser criado para o candidato aparecer
6. **Colunas Talentum nao aceitam drag** — status controlado pelo webhook
