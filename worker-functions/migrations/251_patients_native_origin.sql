BEGIN;

-- ================================================================
-- Migration 251: patients native origin + web-form lead support
-- ================================================================
-- Context: App de Pacientes (3 tasks do Diego) — Fase 0 "pac-core".
-- Goal: make the PATIENT writable natively from inside Enlite (Enlite =
-- source of truth) WITHOUT breaking the existing ClickUp→Enlite sync.
--
-- Until now a patient could ONLY be born from a ClickUp task (the embedded
-- ClickUp form on the site → task → sync). This migration adds the native
-- write path:
--
--   (a) `origin` — where the patient was created. All legacy rows are
--       retro-classified as 'clickup' via the column DEFAULT. Native rows
--       carry 'web_form' (public lead form) or 'admin_manual' (admin panel).
--
--   (b) `clickup_task_id` becomes NULLABLE — native patients have no ClickUp
--       task. NULLs are DISTINCT in Postgres, so the existing
--       `ON CONFLICT (clickup_task_id)` upsert in PatientIdentityRepository
--       stays valid (two native rows never collide on NULL).
--
--   (c) `contact_email_encrypted` — the lead's contact email, KMS-encrypted
--       (same mechanism as patient_responsibles.email_encrypted). Patients
--       had no email column before; leads need one. Ley 25.326 / no PII in
--       plaintext (decisão D10).
--
--   (d) `SOLICITANTE` status — the new head of the funnel (lead: web form or
--       manual pre-interview creation). Recreates the status CHECK to include
--       it. Reuses PENDING_ADMISSION as "esperando activación" (decisão D6).
--
-- Idempotent: safe to re-run (IF NOT EXISTS + DROP CONSTRAINT IF EXISTS).
-- ================================================================

-- ── (a) origin ───────────────────────────────────────────────────────────────
ALTER TABLE patients
  ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'clickup'
  CHECK (origin IN ('clickup', 'web_form', 'admin_manual'));

COMMENT ON COLUMN patients.origin IS
  'Where the patient was created. clickup = born from a ClickUp task (legacy default, all pre-251 rows). web_form = public lead intake form. admin_manual = created in the admin panel. Native rows (web_form/admin_manual) have clickup_task_id NULL and are NOT written back to ClickUp (Enlite = source of truth, decisão D2). Migration 251.';

-- ── (b) allow native patients without a ClickUp task ─────────────────────────
-- Idempotent: DROP NOT NULL on an already-nullable column is a no-op.
ALTER TABLE patients ALTER COLUMN clickup_task_id DROP NOT NULL;

COMMENT ON COLUMN patients.clickup_task_id IS
  'ClickUp task id the patient was synced from. NULL for native patients (origin != clickup). NULLs are distinct in Postgres so ON CONFLICT (clickup_task_id) in PatientIdentityRepository.upsert stays valid. Made nullable in migration 251.';

-- ── (c) lead contact email (KMS-encrypted) ───────────────────────────────────
ALTER TABLE patients
  ADD COLUMN IF NOT EXISTS contact_email_encrypted TEXT;

COMMENT ON COLUMN patients.contact_email_encrypted IS
  'Patient/lead contact email, KMS-encrypted (base64 ciphertext) via the same KMSEncryptionService used for patient_responsibles.email_encrypted. NULL when not provided. Introduced for web-form leads in migration 251. Never store plaintext (Ley 25.326, decisão D10).';

-- ── (d) status CHECK: add SOLICITANTE ────────────────────────────────────────
-- The real constraint name is `patients_status_check`: created inline (auto-
-- named) in migration 143, recreated with the same name in migration 147 when
-- ADMISSION was added. Verified: migration 147 ends with
-- `ADD CONSTRAINT patients_status_check CHECK (...)`.
-- Preserve the `status IS NULL OR ...` shape (migrations 143/147) so existing
-- rows with NULL status don't fail constraint validation.
ALTER TABLE patients DROP CONSTRAINT IF EXISTS patients_status_check;

ALTER TABLE patients
  ADD CONSTRAINT patients_status_check
  CHECK (status IS NULL OR status IN (
    'SOLICITANTE',
    'ADMISSION',
    'PENDING_ADMISSION',
    'ACTIVE',
    'SUSPENDED',
    'DISCONTINUED',
    'DISCHARGED'
  ));

COMMENT ON CONSTRAINT patients_status_check ON patients IS
  'Canonical patient lifecycle statuses. SOLICITANTE (funnel head: web-form / manual pre-interview lead) added in migration 251. ADMISSION added in 147; first 5 in 143. NULL kept allowed for rows whose ClickUp status is unrecognised. PENDING_ADMISSION is reused as "esperando activación" (decisão D6).';

COMMIT;
