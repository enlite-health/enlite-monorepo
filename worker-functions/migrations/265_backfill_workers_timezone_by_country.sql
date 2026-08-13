-- 265_backfill_workers_timezone_by_country.sql
-- TD-028: workers.timezone foi default 'UTC' desde migration 003, nunca populado corretamente.
-- Backfill via workers.country (existe desde migration 002 com CHECK IN ('AR', 'BR')).
--
-- Idempotente: só atualiza linhas onde timezone = 'UTC' (default original).
-- Não sobrescreve valores que já foram setados manualmente em algum momento.
--
-- Mapping alinhado com src/shared/locale/CountryTimezone.ts (PR 1 do sprint MCP).

BEGIN;

-- Trigger update_workers_updated_at (migration 001) tocaria updated_at em TODAS as
-- linhas afetadas pelo backfill, colapsando o timestamp e quebrando o desempate
-- "mais recente vence" usado por WorkerPhoneMergeHelpers.ts e AccountLinkService.ts.
-- Este é um conserto de dado histórico, não uma edição real — updated_at deve seguir
-- refletindo a última mudança de fato do worker, não este script.
ALTER TABLE workers DISABLE TRIGGER update_workers_updated_at;

UPDATE workers
SET timezone = CASE
  WHEN country = 'AR' THEN 'America/Argentina/Buenos_Aires'
  WHEN country = 'BR' THEN 'America/Sao_Paulo'
  ELSE 'UTC'
END
WHERE timezone = 'UTC';

ALTER TABLE workers ENABLE TRIGGER update_workers_updated_at;

-- worker_availability.timezone (criada em migration 003 como copy de workers.timezone)
-- também precisa ser atualizada pra registros existentes.
UPDATE worker_availability wa
SET timezone = w.timezone
FROM workers w
WHERE wa.worker_id = w.id
  AND (wa.timezone IS NULL OR wa.timezone = 'UTC')
  AND w.timezone != 'UTC';

-- Fecha o loop pra não regenerar o problema: caminhos de INSERT que hoje omitem
-- timezone (ProcessTalentumPrescreening.ts, SyncTalentumWorkersUseCase.ts) passam a
-- nascer certos automaticamente, sem precisar tocar em cada call-site. AR é o default
-- histórico de workers.country desde a migration 002.
ALTER TABLE workers ALTER COLUMN timezone SET DEFAULT 'America/Argentina/Buenos_Aires';

COMMIT;
