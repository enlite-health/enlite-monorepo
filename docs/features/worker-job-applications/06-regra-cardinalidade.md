# 06 — Regra de cardinalidade e REPROGRAMAR

## Regra dura

> **1 WJA por par `(worker_id, job_posting_id)`. 1 encuadre por WJA.**

Sem exceções. Sem flag de override. Sem caso especial.

## Garantia técnica

### Em `worker_job_applications`

```sql
ALTER TABLE worker_job_applications
  ADD CONSTRAINT worker_job_applications_worker_job_unique
  UNIQUE (worker_id, job_posting_id);
```

Qualquer INSERT que viole essa constraint falha. Todos os pipelines de criação (matchmaking, self-service, webhook Talentum) usam UPSERT com `ON CONFLICT (worker_id, job_posting_id)` para tratar pré-existência.

### Em `encuadres`

Invariante mantida pelo trigger `trg_ensure_encuadre_on_wja_insert` (migration 189):

- Toda INSERT em `worker_job_applications` cria automaticamente uma linha mínima em `encuadres` se ainda não existir.
- `dedup_hash` UNIQUE em `encuadres` impede duplicatas.
- Para alcançar 1:1 `encuadres` ↔ `worker_job_applications`, a fase F5 inclui consolidação de duplicatas históricas (query de auditoria + merge guiado).

## REPROGRAMAR — comportamento canônico

Quando o prestador pede para reagendar a entrevista (via WhatsApp ou ação admin):

### O que acontece

1. **Edita a WJA existente.** Não cria nova linha.
2. Atualiza `wja.interview_datetime`, `wja.interview_meet_link`, `wja.interview_slot_id`, `wja.interview_response`.
3. Registra a mudança em `worker_job_application_stage_history` com motivo `'REPROGRAMAR'`.
4. Pode disparar nova rodada de 3 meet links (se admin escolher reenviar) — gera nova mensagem WhatsApp interativa apontando para os mesmos campos da WJA.
5. Stage da WJA **não** transita para um estado dedicado de REPROGRAMAR. Continua em `QUALIFIED` ou retorna a `QUALIFIED` se já estava em `CONFIRMED`.

### O que NÃO acontece

- ❌ Nova linha em `worker_job_applications` (violaria a UNIQUE).
- ❌ Nova linha em `encuadres` (comportamento legado pré-2026-05-23, eliminado em F5).
- ❌ Estado `REPROGRAM` no enum — substituído por `interview_response='awaiting_reschedule'` na própria WJA. O stage `REPROGRAM` será removido do enum em F7.

## Histórico de mudanças

Toda transição de stage é registrada em `worker_job_application_stage_history`:

```sql
CREATE TABLE worker_job_application_stage_history (
  id              UUID PRIMARY KEY,
  wja_id          UUID FK,
  from_stage      VARCHAR(30),
  to_stage        VARCHAR(30),
  reason          VARCHAR(100),  -- 'TALENTUM_WEBHOOK', 'ADMIN_DRAG', 'REPROGRAMAR', etc.
  metadata        JSONB,         -- contexto adicional
  created_at      TIMESTAMPTZ,
  created_by      VARCHAR(100)   -- 'system' ou user_id do admin
);
```

Insert-only. Nunca atualizar ou deletar linhas dessa tabela — é trilha de auditoria.

## Casos-limite e como tratar

### Worker se aplica à mesma vaga duas vezes via canais diferentes

Exemplo: o sistema enviou mensagem de match (T1, `source='talent_search'`) e o worker depois clica no link público (T2). O UPSERT em T2 detecta WJA existente, **não atualiza `source`** (mantém `talent_search`), e retorna a WJA existente.

### Worker reativa candidatura após ter sido REJECTED

Não permitido automaticamente. Stage `REJECTED` é terminal. Para reativar, admin precisa intervir manualmente via Kanban (drag) e a operação fica registrada em `stage_history`.

### Talentum envia webhook fora de ordem

Exemplo: chega `COMPLETED` antes de `IN_PROGRESS`. A precedência canônica (migration 185) trata: COMPLETED(3) > IN_PROGRESS(2), então a WJA salta para COMPLETED. O webhook posterior com IN_PROGRESS é no-op (precedência não regride).

### Worker auto-criado pelo webhook Talentum não existe em `workers`

`ProcessTalentumPrescreening` resolve worker por `email → phone → cuil`. Se não encontrar, auto-cria worker com `status='INCOMPLETE_REGISTER'`. WJA é criada normalmente. Operação posterior pode completar o cadastro.

### Duplicatas históricas em `encuadres`

Pode haver linhas duplicadas em `encuadres` para o mesmo `(worker_id, job_posting_id)` por causa do comportamento legado pré-2026-05-23 (REPROGRAMAR criava nova linha) e dos 3 formatos de `dedup_hash` que coexistiram. F5 inclui:

```sql
SELECT worker_id, job_posting_id, COUNT(*)
FROM encuadres
GROUP BY 1, 2
HAVING COUNT(*) > 1;
```

Se a query retornar linhas, merge manual ou script de consolidação é executado antes de adicionar UNIQUE constraint em `encuadres(worker_id, job_posting_id)`.
