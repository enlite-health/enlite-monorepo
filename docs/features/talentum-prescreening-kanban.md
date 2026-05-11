# Talentum Prescreening & Kanban de Encuadres

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
      4. Sincronizar funil (upsert worker_job_applications + encuadre)
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

## Encuadre (entrada no Kanban)

O encuadre e o registro que torna o candidato **visivel no Kanban**. Sem encuadre, o candidato nao aparece.

**Criacao:** `ensureEncuadre` no `ProcessTalentumPrescreening`

```sql
INSERT INTO encuadres (worker_id, job_posting_id, worker_raw_name, worker_raw_phone, origen, dedup_hash)
VALUES ($1, $2, $3, $4, 'Talentum', $5)
ON CONFLICT (dedup_hash) DO UPDATE SET
  worker_id = COALESCE(encuadres.worker_id, EXCLUDED.worker_id),
  updated_at = NOW()
```

**dedup_hash:** `md5("talentum|{prescreening.id}|{profile.id}")` — unico por candidato x prescreening.

---

## Kanban — Frontend

### Colunas (7 colunas atuais)

```
INVITED -> INITIATED -> IN_PROGRESS -> COMPLETED -> CONFIRMED -> SELECTED
                                                              -> REJECTED
```

| Coluna | application_funnel_stage | Cor | Drag-drop? |
|--------|------------------------|-----|------------|
| Invitados | INVITED (auto-match ou sem WJA) | bg-blue-400 | Nao |
| Iniciado | INITIATED (self-application OU Talentum link clicado) | bg-violet-400 | Nao |
| En Progreso | IN_PROGRESS | bg-violet-500 | Nao |
| Completado | COMPLETED, QUALIFIED, IN_DOUBT, NOT_QUALIFIED | bg-violet-600 | Nao |
| Confirmados | CONFIRMED | bg-cyan-400 | Sim |
| Seleccionados | SELECTED, PLACED | bg-green-500 | Sim |
| Rechazados | REJECTED | bg-red-400 | Sim |

**Regra:** colunas Talentum (INITIATED, IN_PROGRESS, COMPLETED) nao aceitam drag — status controlado automaticamente pelo webhook.

### Query do Kanban (backend)

```sql
SELECT e.*, wja.application_funnel_stage AS funnel_stage,
  CASE WHEN wja.source = 'talentum' THEN wja.application_funnel_stage ELSE NULL END AS talentum_status
FROM encuadres e
LEFT JOIN workers w ON w.id = e.worker_id
LEFT JOIN worker_job_applications wja ON wja.worker_id = e.worker_id AND wja.job_posting_id = e.job_posting_id
LEFT JOIN worker_locations wl ON wl.worker_id = e.worker_id
WHERE e.job_posting_id = $1
ORDER BY wja.updated_at DESC NULLS LAST, e.created_at DESC
```

**Ponto critico:** O Kanban faz `FROM encuadres` — sem encuadre, o candidato NAO aparece. O `worker_job_applications` entra via LEFT JOIN para determinar a coluna.

### Classificacao no backend

```typescript
// Prioridade: resultado terminal > funnel_stage > fallback
if (stage === 'SELECTED' || stage === 'PLACED') -> SELECTED
else if (stage === 'REJECTED')                   -> REJECTED
else if (stage === 'CONFIRMED')                  -> CONFIRMED
else if (['COMPLETED', 'QUALIFIED', 'IN_DOUBT', 'NOT_QUALIFIED'].includes(stage)) -> COMPLETED
else if (stage === 'IN_PROGRESS')                -> IN_PROGRESS
else if (stage === 'INITIATED')                  -> INITIATED
else                                             -> INVITED (fallback)
```

### Polling (simulated realtime)

**Hook:** `enlite-frontend/src/hooks/admin/useEncuadreFunnel.ts`

- Polling a cada **5 segundos** via `setInterval`
- Fetch silencioso (sem flicker de loading)
- Guard contra overlap (ref `isFetchingRef` evita requests acumulando)
- Cleanup automatico no unmount (usuario sai da tela -> `clearInterval`)
- Botao "Actualizar" manual continua disponivel

### Talentum badge no card

Cada card exibe um badge com o status Talentum (so se `source = 'talentum'`):

| Badge | Cor |
|-------|-----|
| Iniciado | slate |
| En Progreso | amber |
| Completado | blue |
| Calificado | green |
| En Duda | orange |
| No Calificado | red |

---

## Mover encuadre no Kanban (drag-and-drop)

**Endpoint:** `PUT /api/admin/encuadres/:id/move`
**Body:** `{ targetStage, rejectionReasonCategory?, rejectionReason? }`

Stages validos para mover: `INITIATED, IN_PROGRESS, COMPLETED, QUALIFIED, IN_DOUBT, NOT_QUALIFIED, CONFIRMED, SELECTED, REJECTED`

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
