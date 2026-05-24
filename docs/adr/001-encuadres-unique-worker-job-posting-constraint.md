# ADR 001: Encuadres UNIQUE (worker_id, job_posting_id) Constraint

- **Status:** Proposed
- **Data:** 2026-05-24
- **Decisor(es):** architect + PO (aguardando aprovação humana)
- **Contexto técnico:** worker-functions/src/modules/matching + migrations 192-193

## Context

A tabela `encuadres` tem `dedup_hash VARCHAR(64) UNIQUE` como único árbitro de unicidade (migration 014, linha 117). Existem 6 formatos distintos de `dedup_hash` gerados por call sites diferentes para o mesmo par lógico `(worker_id, job_posting_id)`: `talentum|...` (ProcessTalentumPrescreening.ts:317), `dashboard|...` (SyncTalentumWorkersUseCase.ts:333), `social-link|...` (WorkerApplicationsController.ts:126), `talent-search|...` (WorkerApplicationRepository.ts:66), `backfill-td036|...` (migration 188), `auto-trigger|...` (migration 189). Dois hashes diferentes = dois INSERT bem-sucedidos = duas linhas para o mesmo par real. Isso viola a invariante canônica documentada em `docs/features/worker-job-applications/06-regra-cardinalidade.md`: "1 encuadre por WJA" e "1 WJA por par (worker_id, job_posting_id)".

O contexto de F5 (plano WJA, `docs/features/worker-job-applications/README.md`) é eliminar o comportamento legado de REPROGRAMAR criar nova linha em `encuadres`. `HandleReminderResponseUseCase.ts:188-198` já edita a WJA no lugar correto. O que falta é enforcar no schema que `encuadres` não pode ter dois registros para o mesmo par.

`worker_job_applications` já tem `UNIQUE (worker_id, job_posting_id)` desde migration 011. `encuadres` não tem equivalente. A assimetria é a causa raiz das duplicatas.

## Decision

Adicionar `UNIQUE (worker_id, job_posting_id)` em `encuadres` após consolidação das duplicatas históricas. O `dedup_hash` é mantido como campo de rastreabilidade de origem (NOT NULL) mas deixa de ser o árbitro primário de unicidade de negócio.

Mudanças concretas:

- Migration 192: consolidar duplicatas (identificar sobrevivente por richness_score + recência, COALESCE campos MANTER, DELETE duplicatas). Pré-condição: backup da tabela.
- Migration 193: `ALTER TABLE encuadres ADD CONSTRAINT encuadres_worker_job_unique UNIQUE (worker_id, job_posting_id)`. Deploy order: code primeiro, migration depois.
- `EncuadreRepository.upsert` (EncuadreRepository.ts:62): mudar `ON CONFLICT (dedup_hash)` para `ON CONFLICT (worker_id, job_posting_id)`.
- `EncuadreRepository.bulkUpsert` (EncuadreRepository.ts:140): mesma mudança.
- `ProcessTalentumPrescreening.ts:323-328` (ensureEncuadre inline): mudar `ON CONFLICT (dedup_hash)` para `ON CONFLICT (worker_id, job_posting_id)`.
- `SyncTalentumWorkersUseCase.ts:337-342` (ensureEncuadre inline): mesma mudança.
- `WorkerApplicationsController.ts:130-137`: mesma mudança.
- `WorkerApplicationRepository.ts:70-78`: mesma mudança (já usa WHERE NOT EXISTS guard, adaptar para consistência).
- Trigger `fn_ensure_encuadre_on_wja_insert` (migration 189): já usa `WHERE NOT EXISTS` por par lógico — compatível com a nova constraint. Sem mudança necessária.

## Consequences

### Positivas

- Elimina a classe de bugs de duplicatas em `encuadres` causada por hashes heterogêneos.
- Alinha `encuadres` com a invariante canônica já documentada e já enforçada em `worker_job_applications`.
- Simplifica lógica de upsert: todos os call sites passam a usar o mesmo par semântico natural.
- REPROGRAMAR nunca mais pode criar linha nova em `encuadres` por acidente — o banco rejeitará.
- `syncToWorkerJobApplications` (EncuadreRepository.ts:225) já usa `ON CONFLICT (worker_id, job_posting_id)` — torna-se consistente com o resto do código.

### Negativas

- Migration 192 é destrutiva de dados (DELETE de linhas duplicadas). Exige backup pré-migration e script de auditoria para confirmar que nenhum dado MANTER foi perdido antes do DELETE.
- 6 call sites de INSERT em `encuadres` precisam ser alterados. Volume de mudança moderado mas espalhado em 3 módulos.
- Testes E2E que inserem `encuadres` sem `dedup_hash` podem quebrar se o par já existir no fixture de setup — precisam de revisão de fixtures.
- Janela de risco durante deploy: entre a migration 193 e o code deploy os webhooks Talentum antigos (com `ON CONFLICT (dedup_hash)`) funcionam sem problema, mas se dois webhooks concorrentes chegarem para o mesmo par no intervalo em que 193 já está aplicada mas o código ainda usa hash como árbitro, o segundo INSERT falha com constraint violation. O deploy order (código antes de migration) elimina esse risco.

### Neutras

- `dedup_hash` permanece na tabela como campo de auditoria de origem. Não é removido nesta fase — remoção pode ser considerada em F8 junto com `origen → import_source_audit`.
- Testes que usam `ON CONFLICT (dedup_hash)` diretamente em SQL raw precisam ser atualizados para o novo conflito target, mas seu comportamento lógico não muda.

## Alternatives Considered

### Alternativa A: Manter dedup_hash como árbitro, normalizar todos os formatos para `md5(worker_id||job_posting_id)`

Unificar todos os 6 formatos para um hash determinístico do par. Precisaria de migration de backfill para atualizar todos os hashes existentes + atualizar todos os call sites.

**Descartada porque:** troca wrong abstraction por outra — hash ainda seria indiretamente o par lógico disfarçado. Não resolve o problema conceitual. Qualquer novo call site pode criar um formato novo por descuido. A constraint explícita em `(worker_id, job_posting_id)` é semanticamente correta e auto-documentada.

### Alternativa B: Consolidar duplicatas mas não adicionar UNIQUE constraint — apenas documentar invariante

Fazer a migration 192 de limpeza mas deixar a constraint para uma fase posterior (F8+).

**Descartada porque:** sem constraint enforçada pelo banco, qualquer deploy de código com bug pode reintroduzir duplicatas silenciosamente. A invariante documentada não tem valor se não for enforçada. O risco operacional de F8 ser postergado indefinidamente é real dado o histórico do projeto.

### Alternativa C: Usar advisory locks ou serialização no código em vez de constraint no banco

Implementar idempotência no application layer sem mudar o schema.

**Descartada porque:** viola o princípio de defesa em camadas já adotado no projeto (trigger 189 é exatamente a camada de defesa no banco). Advisory locks são leaky — não funcionam em Cloud Run multi-instance. Constraint no banco é a única garantia forte em ambiente distribuído.

## Rollback

Migration 192 (consolidação): restaurar backup pré-migration via `pg_restore`. Script de rollback é obrigatório antes de executar a migration em produção:

```sql
CREATE TABLE encuadres_backup_pre_f5 AS SELECT * FROM encuadres;
```

DELETE das duplicatas pode ser revertido via:

```sql
INSERT INTO encuadres SELECT * FROM encuadres_backup_pre_f5 WHERE id NOT IN (SELECT id FROM encuadres);
```

Migration 193 (UNIQUE constraint): reversível via:

```sql
ALTER TABLE encuadres DROP CONSTRAINT encuadres_worker_job_unique;
```

Se novas duplicatas foram inseridas após a constraint ser dropada, 192 precisará rodar novamente.

Code revert: se code deploy for revertido após migration 193 já aplicada, o código antigo com `ON CONFLICT (dedup_hash)` funciona normalmente (a nova constraint não interfere enquanto não houver duplicata). Janela segura de rollback: até que o primeiro webhook tente inserir duplicata real.

## Implementation Notes

- Migrations envolvidas: 192 (consolidação de duplicatas) e 193 (ADD UNIQUE constraint)
- Follow-up TD (em `docs/FOLLOWUPS.md`): TD-041

## References

- `docs/features/worker-job-applications/06-regra-cardinalidade.md` — invariante canônica documentada
- `docs/features/worker-job-applications/03-ssot-por-conceito.md` — SSOT por conceito
- `docs/features/worker-job-applications/README.md` — plano de fases F1-F8
- `worker-functions/migrations/014_enlite_ar_operational_schema.sql:117` — definição original `dedup_hash UNIQUE`
- `worker-functions/migrations/189_trigger_ensure_encuadre_on_wja_insert.sql` — trigger compatível
