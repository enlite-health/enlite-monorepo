# Roadmap — Colunas Talentum no Kanban de Encuadres

> Adicionar 3 colunas no kanban (INITIATED, IN_PROGRESS, COMPLETED) entre INVITED e CONFIRMED para visualizar o progresso do candidato no prescreening da Talentum. Quando NOT_QUALIFIED, auto-rejeitar o encuadre.

---

## Status Geral

| Step | Escopo | Status |
|------|--------|--------|
| **Step 1** | Backend: 3 novos stages no EncuadreFunnelController + lógica de classificação | PENDENTE |
| **Step 2** | Backend: Auto-rejeição NOT_QUALIFIED no ProcessTalentumPrescreening | PENDENTE |
| **Step 3** | Frontend: 3 colunas no KanbanBoard + tipo FunnelStages | PENDENTE |
| **Step 4** | QA: Testes, lint, type-check, validação E2E | PENDENTE |

---

## Contexto

### Fluxo atual do kanban (6 colunas)

```
INVITED → CONFIRMED → INTERVIEWING → SELECTED
                                   → REJECTED
                                   → PENDING
```

A classificação é feita no backend (`EncuadreFunnelController.ts:59-106`).
Encuadres sem resultado final e sem meet_link caem em INVITED (linha 105).

### Problema

O `application_funnel_stage` (coluna real em `worker_job_applications`) já é populado via webhook Talentum e retornado pela API como `talentumStatus`. Porém, todos os encuadres em prescreening ficam misturados na coluna INVITED, sem visibilidade do progresso no bot da Talentum.

### Solução

Adicionar 3 colunas entre INVITED e CONFIRMED:

```
INVITED → INITIATED → IN_PROGRESS → COMPLETED → CONFIRMED → INTERVIEWING → SELECTED
                                                                          → REJECTED
                                                                          → PENDING
```

### Cadeia de dados (fonte → UI)

1. `worker_job_applications.application_funnel_stage` — coluna real no banco (VARCHAR(30))
2. `EncuadreFunnelController.ts:47` — alias SQL: `wja.application_funnel_stage AS talentum_status`
3. `EncuadreFunnelController.ts:85` — DTO da API: `talentumStatus: row.talentum_status ?? null`
4. `useEncuadreFunnel.ts:17` — interface frontend: `FunnelEncuadre.talentumStatus`
5. `KanbanCard.tsx:11` — prop do componente

### Mapeamento application_funnel_stage → coluna do kanban

| application_funnel_stage | Coluna kanban | Notas |
|--------------------------|---------------|-------|
| `INVITED` | INVITED | Auto-match (sistema convidou o worker) ou sem interação |
| `INITIATED` | INITIATED | Self-application (clicou "postularse" no painel público) **ou** clicou no link Talentum / entrou no WhatsApp |
| `IN_PROGRESS` | IN_PROGRESS | Respondeu pelo menos 1 pergunta |
| `COMPLETED` | COMPLETED | Terminou todas as perguntas |
| `QUALIFIED` | COMPLETED | Talentum aprovou — aguarda convite WhatsApp |
| `IN_DOUBT` | COMPLETED | Talentum em dúvida — aguarda revisão |
| `NOT_QUALIFIED` | REJECTED | Auto-rejeitado com motivo TALENTUM_NOT_QUALIFIED |
| `null` (sem registro) | INVITED | Sem WJA — fallback (raro) |

---

## Step 1 — Backend: 3 novos stages no EncuadreFunnelController

**Objetivo:** Alterar a lógica de classificação do funnel para reconhecer `application_funnel_stage` e distribuir encuadres nas 3 novas colunas.

### O que existe hoje

- `EncuadreFunnelController.ts:59-66` — objeto `stages` com 6 chaves (INVITED, CONFIRMED, INTERVIEWING, SELECTED, REJECTED, PENDING)
- `EncuadreFunnelController.ts:90-106` — lógica de classificação baseada em `resultado`, `interview_date`, `meet_link`, `attended`
- `EncuadreFunnelController.ts:47` — query já faz JOIN com `worker_job_applications` e retorna `application_funnel_stage` como `talentum_status`
- `EncuadreFunnelController.ts:85` — DTO já mapeia `talentumStatus: row.talentum_status ?? null`

### O que muda

1. Adicionar 3 chaves ao objeto `stages` (linha 59):
   ```typescript
   const stages: Record<string, unknown[]> = {
     INVITED: [],
     INITIATED: [],      // NOVO
     IN_PROGRESS: [],    // NOVO
     COMPLETED: [],      // NOVO
     CONFIRMED: [],
     INTERVIEWING: [],
     SELECTED: [],
     REJECTED: [],
     PENDING: [],
   };
   ```

2. Alterar a lógica de classificação (entre as linhas 96 e 97), ANTES da lógica de interview_date/meet_link. Após checar resultados finais (SELECTED/REJECTED/PENDING), adicionar:
   ```typescript
   // Encuadres em prescreening Talentum (application_funnel_stage via talentumStatus)
   } else if (row.talentum_status === 'INITIATED') {
     stages.INITIATED.push(item);
   } else if (row.talentum_status === 'IN_PROGRESS') {
     stages.IN_PROGRESS.push(item);
   } else if (['COMPLETED', 'QUALIFIED', 'IN_DOUBT'].includes(row.talentum_status)) {
     stages.COMPLETED.push(item);
   // NOT_QUALIFIED sem resultado já foi auto-rejeitado (Step 2) → cai em REJECTED acima
   // Se por algum motivo não foi, classificar como INVITED (fallback seguro)
   ```

### Critérios de aceite

- CA-1.1: API retorna 9 stages no response (INVITED, INITIATED, IN_PROGRESS, COMPLETED, CONFIRMED, INTERVIEWING, SELECTED, REJECTED, PENDING)
- CA-1.2: Encuadre com `application_funnel_stage = 'INITIATED'` e sem resultado → INITIATED
- CA-1.3: Encuadre com `application_funnel_stage = 'IN_PROGRESS'` e sem resultado → IN_PROGRESS
- CA-1.4: Encuadre com `application_funnel_stage = 'COMPLETED'` e sem resultado → COMPLETED
- CA-1.5: Encuadre com `application_funnel_stage = 'QUALIFIED'` e sem resultado → COMPLETED
- CA-1.6: Encuadre com `application_funnel_stage = 'IN_DOUBT'` e sem resultado → COMPLETED
- CA-1.7: Encuadre com `application_funnel_stage = null` e sem resultado → INVITED (lógica original)
- CA-1.8: Encuadre com resultado final (SELECCIONADO, RECHAZADO, etc.) → lógica original (SELECTED/REJECTED/PENDING), independente do `application_funnel_stage`

### Arquivos impactados

| Arquivo | Ação |
|---------|------|
| `worker-functions/src/interfaces/controllers/EncuadreFunnelController.ts` | MODIFICAR — stages + classificação |

---

## Step 2 — Backend: Auto-rejeição NOT_QUALIFIED

**Objetivo:** Quando o webhook Talentum informa `NOT_QUALIFIED`, atualizar automaticamente o encuadre correspondente para `resultado = 'RECHAZADO'` com `rejection_reason_category = 'TALENTUM_NOT_QUALIFIED'`.

### O que existe hoje

- `ProcessTalentumPrescreening.ts:157-197` — método `upsertApplicationAndEmitEvent` com transação:
  - Upsert em `worker_job_applications` (via repositório)
  - INSERT em `domain_events` apenas para `QUALIFIED` (linha 175)
  - Publish Pub/Sub após COMMIT (linha 188-189)
- `Encuadre.ts:9` — `RejectionReasonCategory` já inclui `TALENTUM_NOT_QUALIFIED`

### O que muda

No método `upsertApplicationAndEmitEvent`, após o bloco de QUALIFIED (linha 175-183), adicionar bloco simétrico para NOT_QUALIFIED:

```typescript
// Se transitou para NOT_QUALIFIED, auto-rejeitar o encuadre
if (statusLabel === 'NOT_QUALIFIED' && previousStage !== 'NOT_QUALIFIED') {
  // Só rejeita se resultado ainda não foi definido manualmente
  await client.query(
    `UPDATE encuadres
     SET resultado = 'RECHAZADO',
         rejection_reason_category = 'TALENTUM_NOT_QUALIFIED',
         updated_at = NOW()
     WHERE worker_id = $1
       AND job_posting_id = $2
       AND resultado IS NULL`,
    [workerId, jobPostingId]
  );

  // Domain event (simétrico ao funnel_stage.qualified)
  const eventResult = await client.query(
    `INSERT INTO domain_events (event, payload)
     VALUES ('funnel_stage.not_qualified', $1::jsonb)
     RETURNING id`,
    [JSON.stringify({ workerId, jobPostingId })],
  );
  pendingEventId = eventResult.rows[0].id;
}
```

### Critérios de aceite

- CA-2.1: Webhook com `statusLabel = NOT_QUALIFIED` + encuadre com `resultado IS NULL` → encuadre atualizado para `RECHAZADO` + `TALENTUM_NOT_QUALIFIED`
- CA-2.2: Encuadre com resultado já definido (manual) → NÃO sobrescrito
- CA-2.3: Sem encuadre para o par (worker_id, job_posting_id) → sem erro (UPDATE 0 rows)
- CA-2.4: `previousStage` já era `NOT_QUALIFIED` → não re-executa (deduplicação)
- CA-2.5: Tudo dentro da mesma transação do upsert de `worker_job_applications`
- CA-2.6: Domain event `funnel_stage.not_qualified` emitido + publicado no Pub/Sub
- CA-2.7: Em dryRun → nenhuma alteração

### Arquivos impactados

| Arquivo | Ação |
|---------|------|
| `worker-functions/src/application/usecases/ProcessTalentumPrescreening.ts` | MODIFICAR — bloco NOT_QUALIFIED |
| `worker-functions/src/application/usecases/__tests__/ProcessTalentumPrescreening.test.ts` | MODIFICAR — novos cenários |

---

## Step 3 — Frontend: 3 colunas no KanbanBoard

**Objetivo:** Exibir as 3 novas colunas no kanban entre INVITED e CONFIRMED. Colunas não aceitam drag (status controlado pela Talentum).

### O que existe hoje

- `useEncuadreFunnel.ts:22-29` — tipo `FunnelStages` com 6 chaves
- `KanbanBoard.tsx:14-21` — constante `COLUMN_CONFIG` com 6 colunas (label + cor)
- `KanbanCard.tsx:29-36` — `TALENTUM_STATUS_CONFIG` com badges para os 6 status

### O que muda

1. **`useEncuadreFunnel.ts`** — adicionar 3 chaves ao tipo `FunnelStages`:
   ```typescript
   INITIATED: FunnelEncuadre[];
   IN_PROGRESS: FunnelEncuadre[];
   COMPLETED: FunnelEncuadre[];
   ```

2. **`KanbanBoard.tsx`** — adicionar 3 entradas ao `COLUMN_CONFIG` entre INVITED e CONFIRMED:
   ```typescript
   INITIATED:   { label: 'Iniciado',    color: 'bg-violet-400' },
   IN_PROGRESS: { label: 'En Progreso', color: 'bg-violet-500' },
   COMPLETED:   { label: 'Completado',  color: 'bg-violet-600' },
   ```

3. **`KanbanBoard.tsx`** — as 3 colunas novas NÃO aceitam drag-and-drop como destino (não têm `resultado` associado — o status é controlado automaticamente pela Talentum)

### Critérios de aceite

- CA-3.1: Kanban exibe 9 colunas na ordem: Invitados, Iniciado, En Progreso, Completado, Confirmados, Entrevistando, Seleccionados, Rechazados, Pendientes
- CA-3.2: Cards nas 3 colunas novas mostram badge do `talentumStatus` (já implementado no KanbanCard)
- CA-3.3: Não é possível arrastar cards PARA as 3 colunas novas (apenas DE)
- CA-3.4: `pnpm type-check` passa sem erros
- CA-3.5: `pnpm lint` passa sem erros

### Arquivos impactados

| Arquivo | Ação |
|---------|------|
| `enlite-frontend/src/hooks/admin/useEncuadreFunnel.ts` | MODIFICAR — tipo FunnelStages |
| `enlite-frontend/src/presentation/components/features/admin/Kanban/KanbanBoard.tsx` | MODIFICAR — COLUMN_CONFIG + drag rules |

---

## Step 4 — QA: Validação completa

### Checklist

**Backend:**
- [ ] Endpoint `GET /api/admin/vacancies/:id/funnel` retorna 9 stages
- [ ] Encuadre com `application_funnel_stage = 'IN_PROGRESS'` aparece no stage IN_PROGRESS
- [ ] Encuadre com `application_funnel_stage = 'QUALIFIED'` aparece no stage COMPLETED
- [ ] Encuadre com resultado `SELECCIONADO` permanece em SELECTED (independente do `application_funnel_stage`)
- [ ] Webhook NOT_QUALIFIED → encuadre auto-rejeitado com TALENTUM_NOT_QUALIFIED
- [ ] Encuadre com resultado manual NÃO é sobrescrito pelo NOT_QUALIFIED
- [ ] Webhook duplicado (previousStage = NOT_QUALIFIED) não re-processa
- [ ] `npm test` — testes unitários passam
- [ ] Nenhum arquivo ultrapassa 400 linhas

**Frontend:**
- [ ] Kanban exibe 9 colunas na ordem correta
- [ ] Cards nas colunas Talentum mostram badge com status correto
- [ ] Não é possível arrastar cards PARA colunas Talentum
- [ ] Encuadre NOT_QUALIFIED aparece em Rechazados com badge "Talentum no calificado"
- [ ] Encuadre sem `application_funnel_stage` permanece em Invitados
- [ ] `pnpm type-check` passa
- [ ] `pnpm lint` passa

---

## Referências

- Cadeia de dados: `worker_job_applications.application_funnel_stage` → alias `talentum_status` (controller:47) → DTO `talentumStatus` (controller:85) → `FunnelEncuadre.talentumStatus` (hook:17) → prop `KanbanCard` (card:11)
- Padrão de transação + domain event: `ROADMAP_QUALIFIED_INTERVIEW_FLOW.md` Step 4 (linhas 428-465)
- Documentação do kanban: `docs/features/matching-selection.md`
- Documentação do webhook Talentum: `docs/features/webhooks-integrations.md`
