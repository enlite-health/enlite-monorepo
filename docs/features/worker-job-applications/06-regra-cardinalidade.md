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

## REPROGRAMAR — comportamento canônico (HOJE)

Quando o prestador pede para reagendar a entrevista via WhatsApp (botão `reschedule_yes` no template Twilio):

### O que acontece HOJE (estado real, descoberto pela Discovery F7)

1. **Edita a WJA existente.** Não cria nova linha (UNIQUE composta + ON CONFLICT garantem).
2. `HandleReminderResponseUseCase.handleRescheduleYes:188-198` executa UPDATE:
   - `application_funnel_stage = 'REPROGRAM'` (writer ATIVO — estado transiente)
   - `interview_response = 'pending'`
   - `interview_meet_link = NULL`, `interview_datetime = NULL`, `interview_slot_id = NULL` (libera slot)
3. Libera o slot do `interview_slots` (decrement booked_count).
4. Envia mensagem WhatsApp de confirmação.
5. **Worker fica em REPROGRAM** até admin/automação reenviar nova rodada de meet links (não há fluxo automático hoje — admin precisa intervir manualmente via Kanban).

### O que NÃO acontece

- ❌ Nova linha em `worker_job_applications` (UNIQUE bloqueia).
- ❌ Nova linha em `encuadres` (comportamento legado pré-2026-05-23, F5 garantiu via constraint UNIQUE composta).

### O que VAI MUDAR em F7.b

F7.b vai refatorar `HandleReminderResponseUseCase.handleRescheduleYes` após decisão de produto (ADR-003 ampliado):
- Opção A: stage volta pra `QUALIFIED` (reativa o trigger `funnel_stage.qualified` → novo envio de meet links automático)
- Opção B: stage vai pra `REJECTED` automaticamente (admin tem que reativar manualmente se quiser dar segunda chance)
- Opção C: stage fica em `CONFIRMED` mas com `interview_response='awaiting_reschedule'` (flag separado, não muda stage)

A decisão será documentada em **ADR-003** antes da implementação. Após a refatoração, `REPROGRAM` será removido do enum + CHECK + função SQL.

> **Nota:** doc anterior afirmava "REPROGRAM substituído por `interview_response='awaiting_reschedule'`" — Discovery F7 (DBA) provou que **`awaiting_reschedule` nunca foi gravado em prod** (0 linhas). A afirmação era estado desejado/futuro, não atual.

## Histórico de mudanças

Toda transição de stage é registrada em `worker_job_application_stage_history`:

```sql
-- Schema REAL em prod (descoberto pela Discovery F7 DBA, 2026-05-24)
-- migration 169 + alterações posteriores
CREATE TABLE worker_job_application_stage_history (
  id              UUID PRIMARY KEY,
  wja_id          UUID FK worker_job_applications,
  field_name      VARCHAR(50),    -- 'application_funnel_stage' (genérico — pode rastrear outros campos)
  old_value       VARCHAR(100),   -- stage anterior (ex: 'IN_PROGRESS')
  new_value       VARCHAR(100),   -- stage novo (ex: 'COMPLETED')
  reason          VARCHAR(100),   -- 'TALENTUM_WEBHOOK', 'ADMIN_DRAG', 'REPROGRAMAR', 'AUTO_REJECT_NOT_QUALIFIED', etc.
  metadata        JSONB,          -- contexto adicional (webhook payload, admin user_id, etc.)
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
```

**Importante:** o schema usa `field_name` / `old_value` / `new_value` (genérico, suporta auditoria de outros campos no futuro), não `from_stage` / `to_stage` (que era o design originalmente documentado mas nunca foi implementado assim).

Insert-only. Nunca atualizar ou deletar linhas dessa tabela — é trilha de auditoria.

**Limitação conhecida (Discovery F7 DBA):** o histórico tem dados apenas a partir de 2026-05-20. Transições anteriores (bulk import de março-abril) não estão rastreadas.

## Casos-limite e como tratar

### Worker se aplica à mesma vaga duas vezes via canais diferentes

Exemplo: o sistema enviou mensagem de match (T1, `source='talent_search'`) e o worker depois clica no link público (T2). O UPSERT em T2 detecta WJA existente, **não atualiza `source`** (mantém `talent_search`), e retorna a WJA existente.

### Worker reativa candidatura após ter sido REJECTED

Não permitido automaticamente. Stage `REJECTED` é terminal. Para reativar, admin precisa intervir manualmente via Kanban (drag) e a operação fica registrada em `stage_history`.

### Talentum envia webhook fora de ordem

Exemplo: chega `COMPLETED` antes de `IN_PROGRESS`. A precedência canônica (migration 185) trata: COMPLETED(3) > IN_PROGRESS(2), então a WJA salta para COMPLETED. O webhook posterior com IN_PROGRESS é no-op (precedência não regride).

### Worker auto-criado pelo webhook Talentum não existe em `workers`

`ProcessTalentumPrescreening` resolve worker por `email → phone → cuil`. Se não encontrar, auto-cria worker com `status='INCOMPLETE_REGISTER'`. WJA é criada normalmente. Operação posterior pode completar o cadastro.

### Duplicatas históricas em `encuadres` (RESOLVIDO em F5)

Existiam linhas duplicadas em `encuadres` para o mesmo `(worker_id, job_posting_id)` por causa do comportamento legado pré-2026-05-23 e dos múltiplos formatos de `dedup_hash` que coexistiram. F5 (commit `2cc7d06`, migrations 192/193) resolveu:

- Migration 192: consolidação atomic de ~20k duplicatas via richness score + recência, com backup `encuadres_backup_pre_f5` + tabela de auditoria `encuadres_consolidation_audit`
- Migration 193: `ALTER TABLE encuadres ADD CONSTRAINT encuadres_worker_job_unique UNIQUE (worker_id, job_posting_id)`
- 6 call sites atualizados de `ON CONFLICT (dedup_hash)` para `ON CONFLICT (worker_id, job_posting_id)`
- Trigger 189 atualizado dentro da mesma migration

Query de verificação (deve retornar 0):

```sql
SELECT worker_id, job_posting_id, COUNT(*)
FROM encuadres
WHERE worker_id IS NOT NULL AND job_posting_id IS NOT NULL
GROUP BY 1, 2
HAVING COUNT(*) > 1;
```

Detalhes: [ADR-001](../../adr/001-encuadres-unique-worker-job-posting-constraint.md).
