-- 503 — Aba Admissão (spec 049, F1): rastreio da reunião em `admission_appointments`
--
-- POR QUÊ: a aba nova precisa (a) achar a reunião pelo código ADM-XXXXXX que vai no título do evento, (b) saber se ela nasceu
-- no site ou no painel e quem a criou/cancelou, (c) guardar o espaço do Meet e o fim da conferência para a importação do
-- Tactiq e (d) o estado dessa importação. Linhas ANTIGAS ficam NULL em tudo que é novo (não há código ADM em prd; a
-- importação só vale para reunião nova) — por isso as colunas nascem NULLABLE, exceto `created_via` (DEFAULT 'site') e
-- `import_attempts` (DEFAULT 0), que descrevem o que as linhas antigas de fato são.
--
-- Idempotente (2×): ADD COLUMN IF NOT EXISTS; CHECKs nomeados com DROP CONSTRAINT IF EXISTS + ADD; índice IF NOT EXISTS.
-- ROLLBACK: migrations/pending/ROLLBACK_503_admission_049_appointments_tracking.sql

BEGIN;

ALTER TABLE admission_appointments
  ADD COLUMN IF NOT EXISTS admission_code       TEXT         NULL,
  ADD COLUMN IF NOT EXISTS created_via          TEXT         NOT NULL DEFAULT 'site',
  ADD COLUMN IF NOT EXISTS created_by_uid       VARCHAR(128) NULL,
  ADD COLUMN IF NOT EXISTS cancelled_at         TIMESTAMPTZ  NULL,
  ADD COLUMN IF NOT EXISTS cancelled_by_uid     VARCHAR(128) NULL,
  ADD COLUMN IF NOT EXISTS meet_space_name      TEXT         NULL,
  ADD COLUMN IF NOT EXISTS conference_ended_at  TIMESTAMPTZ  NULL,
  ADD COLUMN IF NOT EXISTS import_status        TEXT         NULL,
  ADD COLUMN IF NOT EXISTS import_attempts      SMALLINT     NOT NULL DEFAULT 0;

ALTER TABLE admission_appointments DROP CONSTRAINT IF EXISTS admission_appointments_code_format;
ALTER TABLE admission_appointments
  ADD CONSTRAINT admission_appointments_code_format
  CHECK (admission_code IS NULL OR admission_code ~ '^ADM-[0-9A-Z]{6}$');

ALTER TABLE admission_appointments DROP CONSTRAINT IF EXISTS admission_appointments_created_via_check;
ALTER TABLE admission_appointments
  ADD CONSTRAINT admission_appointments_created_via_check
  CHECK (created_via IN ('site', 'panel'));

ALTER TABLE admission_appointments DROP CONSTRAINT IF EXISTS admission_appointments_import_status_check;
ALTER TABLE admission_appointments
  ADD CONSTRAINT admission_appointments_import_status_check
  CHECK (import_status IS NULL OR import_status IN
    ('pending', 'waiting', 'done', 'rejected', 'ambiguous', 'expired', 'blocked', 'no_show'));

-- O código é a chave de busca da importação: único quando existe (linhas antigas ficam fora do índice).
CREATE UNIQUE INDEX IF NOT EXISTS uq_admission_appointments_code
  ON admission_appointments (admission_code) WHERE admission_code IS NOT NULL;

COMMENT ON COLUMN admission_appointments.admission_code IS
  'Código ADM-XXXXXX que vai no título do evento do Calendar e liga a reunião à transcrição (spec 049). NULL nas reuniões antigas.';
COMMENT ON COLUMN admission_appointments.import_status IS
  'Estado da importação do Tactiq (spec 049). NULL = reunião antiga, fora da importação.';

COMMIT;
