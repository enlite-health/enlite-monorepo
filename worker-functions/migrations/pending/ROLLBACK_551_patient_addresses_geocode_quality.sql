-- ROLLBACK_551_patient_addresses_geocode_quality.sql — par de rollback da migration 551
-- (qualidade do geocode em patient_addresses, spec 077 §8.3).
--
-- Mora em `migrations/pending/` (sem número) porque o runner só lê `migrations/` sem recursão.
-- Só roda quando alguém aponta o caminho explicitamente:
--   ./scripts/run-migration-prod.sh worker-functions/migrations/pending/ROLLBACK_551_patient_addresses_geocode_quality.sql
--
-- Descarta os 3 campos (e o CHECK junto). lat/lng não são tocados.

ALTER TABLE patient_addresses
  DROP COLUMN IF EXISTS geocode_quality,
  DROP COLUMN IF EXISTS geocode_partial_match,
  DROP COLUMN IF EXISTS geocoded_at;
