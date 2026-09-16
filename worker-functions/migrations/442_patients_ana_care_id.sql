BEGIN;

-- ================================================================
-- Migration 442: patients.ana_care_id (spec 003)
-- ================================================================
-- Context: a plataforma precisa achar o paciente nos DOIS espelhos a partir
-- da própria linha — clickup_task_id já existe (037/251); o Ana Care só
-- existia via patient_identity_links, assimétrico. Decisão do Gabriel em
-- 27/08: coluna direta, no molde de workers.ana_care_id (014/231).
--
-- Preenchida pela reconciliação quando o link ANACARE fica AUTO/CONFIRMED
-- (e limpa se DENIED). Enquanto o export do Ana Care não trouxer o id deles,
-- o valor é o external_id estável (hash nome+nascimento, prefixo "h:") — o
-- próprio valor diz de onde veio.
--
-- Idempotent. Molde: migration 231 (índice único parcial).
-- ================================================================

ALTER TABLE patients
  ADD COLUMN IF NOT EXISTS ana_care_id TEXT;

COMMENT ON COLUMN patients.ana_care_id IS
  'Identificador do paciente no Ana Care (espelho de destino). Preenchido pela reconciliação '
  '(patient_identity_links ANACARE em AUTO/CONFIRMED); NULL = ainda não ligado. Prefixo "h:" = '
  'id estável derivado (export sem coluna de id). Simétrico a clickup_task_id. Migration 442 (spec 003).';

CREATE UNIQUE INDEX IF NOT EXISTS idx_patients_ana_care_id_unique
  ON patients (ana_care_id)
  WHERE ana_care_id IS NOT NULL AND deleted_at IS NULL;

COMMIT;
