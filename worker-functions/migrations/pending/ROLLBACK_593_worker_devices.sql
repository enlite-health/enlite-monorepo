-- ROLLBACK_593_worker_devices.sql — par de rollback da migration 593 (spec 077, D795).
--
-- Mora em `migrations/pending/` (sem número): o runner só lê `migrations/` sem recursão. Só roda apontado:
--   ./scripts/run-migration-prod.sh worker-functions/migrations/pending/ROLLBACK_593_worker_devices.sql
-- Derruba a tabela (índice e CHECKs vão junto). O vínculo e a trilha de revogação se perdem; a cuidadora liga o aparelho de novo no login.
DROP TABLE IF EXISTS worker_devices;
