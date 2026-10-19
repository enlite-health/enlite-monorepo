-- ROLLBACK_532_insurance_providers_cadastro.sql — par de rollback da migration 532 (spec 058 Parte A).
-- ATENÇÃO: descarta `name`, `legal_name`, `tax_id`, `address`, `management_chat_id` e `payer_kind` digitados depois do deploy.
-- Rodar DEPOIS dos rollbacks 533..537 (histórico, contatos, contratos e a T5 dependem destas colunas).
--   ./scripts/run-migration-prod.sh worker-functions/migrations/pending/ROLLBACK_532_insurance_providers_cadastro.sql
DROP TRIGGER IF EXISTS trg_058_a_providers_retired_at ON insurance_providers;
DROP TRIGGER IF EXISTS trg_058_a_payer_kind_no_unset ON insurance_providers;
DROP FUNCTION IF EXISTS fn_058_a_providers_retired_at();
DROP FUNCTION IF EXISTS fn_058_a_payer_kind_no_unset();
ALTER TABLE insurance_providers
  DROP CONSTRAINT IF EXISTS insurance_providers_other_unclassified_chk,
  DROP CONSTRAINT IF EXISTS insurance_providers_private_kind_chk,
  DROP CONSTRAINT IF EXISTS insurance_providers_payer_kind_check,
  DROP CONSTRAINT IF EXISTS insurance_providers_management_chat_id_not_blank,
  DROP CONSTRAINT IF EXISTS insurance_providers_tax_id_uq,
  DROP CONSTRAINT IF EXISTS insurance_providers_name_uq,
  DROP CONSTRAINT IF EXISTS insurance_providers_name_not_blank,
  DROP COLUMN IF EXISTS payer_kind,
  DROP COLUMN IF EXISTS management_chat_id,
  DROP COLUMN IF EXISTS address,
  DROP COLUMN IF EXISTS tax_id,
  DROP COLUMN IF EXISTS legal_name,
  DROP COLUMN IF EXISTS name;
