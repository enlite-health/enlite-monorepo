BEGIN;

-- ================================================================
-- Migration 256: admission anti-double-book guard → per COUNTRY, not per host
-- ================================================================
-- Context: App de Pacientes — worktree `pac-integration`. The admission
-- scheduler was refactored so availability is the COUNTRY'S admission calendar
-- (business hours minus what is already booked on it, capacity 1: one interview
-- per slot), NOT a per-interviewer roster. The people who run interviews rotate,
-- so there is no stable host to key uniqueness on.
--
-- Therefore the anti-double-book guard flips:
--   before (252): UNIQUE(host_email, slot_start) — one host, one slot
--   after  (256): UNIQUE(country, slot_start)    — one interview per slot/country
--
-- host_email now stores the country calendar id (no person); host_display_name
-- stores the generic team name (e.g. "Equipo de Admisión EnLite"). The
-- interview_hosts table is orphaned (no longer queried); left in place — not
-- dropped — to avoid breaking anything that still reads it.
--
-- Idempotent: safe to re-run (DROP INDEX IF EXISTS + CREATE UNIQUE INDEX IF NOT EXISTS).
-- The old index was created in 252 as `uq_admission_appointments_host_slot`.
-- ================================================================

-- Drop the per-host guard from migration 252.
DROP INDEX IF EXISTS uq_admission_appointments_host_slot;

-- New guard: at most one appointment per (country, slot_start). Guarantees
-- "1 entrevista por horário" per country even under concurrent bookings.
CREATE UNIQUE INDEX IF NOT EXISTS uq_admission_appointments_country_slot
  ON admission_appointments (country, slot_start);

COMMIT;
