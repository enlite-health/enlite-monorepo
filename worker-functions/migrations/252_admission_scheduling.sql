BEGIN;

-- ================================================================
-- Migration 252: admission interview scheduling core (multi-country AR + BR)
-- ================================================================
-- Context: App de Pacientes — worktree `pac-agenda`. Builds the native
-- admission-interview scheduling core on top of the native patient (251).
--
--   (a) patients.country — which country the patient belongs to. Drives the
--       scheduling config (timezone, holidays, business hours, admission
--       calendar). All legacy rows retro-classified as 'AR' via DEFAULT (the
--       operation is Argentina today). Matches the value PatientIdentityRepository
--       already writes (defaults to 'AR').
--
--   (b) interview_hosts — the people who run admission interviews, per country.
--       Availability comes from each host's PERSONAL Google calendar (read via
--       DWD); this table only says WHO and WHERE (country) + on/off (active).
--
--   (c) admission_appointments — a booked interview slot. The
--       UNIQUE(host_email, slot_start) index is our own anti-double-book guard
--       (defense-in-depth alongside the live calendar re-check).
--
-- Idempotent: safe to re-run (IF NOT EXISTS + DROP CONSTRAINT IF EXISTS).
-- Molde: migrations 168 / 251.
-- ================================================================

-- ── (a) patients.country ─────────────────────────────────────────────────────
ALTER TABLE patients
  ADD COLUMN IF NOT EXISTS country TEXT NOT NULL DEFAULT 'AR'
  CHECK (country IN ('AR', 'BR'));

COMMENT ON COLUMN patients.country IS
  'Country the patient belongs to (AR | BR). Drives admission scheduling config (timezone, holidays, business hours, dedicated admission calendar). Legacy rows retro-classified as AR via DEFAULT. Migration 252.';

-- ── (b) interview_hosts ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS interview_hosts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email        TEXT UNIQUE NOT NULL,
  display_name TEXT,
  country      TEXT NOT NULL CHECK (country IN ('AR', 'BR')),
  active       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE interview_hosts IS
  'People who run admission interviews. Availability is read from each host''s PERSONAL Google calendar (DWD). This table only holds identity (email), country, and active flag. Migration 252.';

CREATE INDEX IF NOT EXISTS idx_interview_hosts_country_active
  ON interview_hosts (country, active);

-- ── (c) admission_appointments ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admission_appointments (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id         UUID REFERENCES patients(id),
  country            TEXT NOT NULL CHECK (country IN ('AR', 'BR')),
  host_email         TEXT NOT NULL,
  host_display_name  TEXT,
  slot_start         TIMESTAMPTZ NOT NULL,
  slot_end           TIMESTAMPTZ NOT NULL,
  calendar_event_id  TEXT,
  meet_link          TEXT,
  status             TEXT NOT NULL DEFAULT 'booked'
                       CHECK (status IN ('booked', 'cancelled', 'completed', 'no_show')),
  reminder_task_name TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE admission_appointments IS
  'A booked admission-interview slot: patient + host + time + Meet/calendar refs. UNIQUE(host_email, slot_start) is our own anti-double-book guard (defense-in-depth alongside the live calendar re-check). Migration 252.';

CREATE INDEX IF NOT EXISTS idx_admission_appointments_patient
  ON admission_appointments (patient_id);

-- Anti-corrida do nosso lado: um host não pode ter 2 appointments no mesmo start.
CREATE UNIQUE INDEX IF NOT EXISTS uq_admission_appointments_host_slot
  ON admission_appointments (host_email, slot_start);

COMMIT;
