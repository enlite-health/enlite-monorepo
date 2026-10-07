-- ROLLBACK_500_patient_billing_address.sql — par de rollback da migration 500 (faturamento do paciente, spec 044).
--
-- Mora em `migrations/pending/` (sem número): o runner não lê subpastas, então o arquivo fica versionado mas só
-- roda quando alguém aponta o caminho explicitamente.
--
-- Como rodar (reversão manual e intencional):
--   ./scripts/run-migration-prod.sh worker-functions/migrations/pending/ROLLBACK_500_patient_billing_address.sql
--
-- ATENÇÃO: descarta o endereço de faturamento digitado pelos operadores depois do deploy (o backfill se refaz
-- reaplicando a 500, mas o que foi editado à mão se perde). Reverter o front antes.
ALTER TABLE patients
  DROP COLUMN IF EXISTS billing_address_formatted,
  DROP COLUMN IF EXISTS billing_city,
  DROP COLUMN IF EXISTS billing_province;
