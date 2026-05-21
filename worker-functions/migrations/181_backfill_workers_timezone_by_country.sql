-- 181_backfill_workers_timezone_by_country.sql
-- TD-028: workers.timezone foi default 'UTC' desde migration 003, nunca populado corretamente.
-- Backfill via workers.country (existe desde migration 002 com CHECK IN ('AR', 'BR')).
--
-- Idempotente: só atualiza linhas onde timezone = 'UTC' (default original).
-- Não sobrescreve valores que já foram setados manualmente em algum momento.
--
-- Mapping alinhado com src/shared/locale/CountryTimezone.ts (PR 1 do sprint MCP).

UPDATE workers
SET timezone = CASE
  WHEN country = 'AR' THEN 'America/Argentina/Buenos_Aires'
  WHEN country = 'BR' THEN 'America/Sao_Paulo'
  ELSE 'UTC'
END
WHERE timezone = 'UTC';

-- worker_availability.timezone (criada em migration 003 como copy de workers.timezone)
-- também precisa ser atualizada pra registros existentes.
UPDATE worker_availability wa
SET timezone = w.timezone
FROM workers w
WHERE wa.worker_id = w.id
  AND (wa.timezone IS NULL OR wa.timezone = 'UTC')
  AND w.timezone != 'UTC';
