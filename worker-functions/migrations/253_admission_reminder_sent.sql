BEGIN;

-- ================================================================
-- Migration 253: admission 30-min reminder idempotency flag
-- ================================================================
-- Context: App de Pacientes — worktree `pac-agenda`. Notifications phase on top
-- of the scheduling core (252). When a slot is booked we schedule a Cloud Task
-- for 30 minutes before the interview (queue `admission-reminders` →
-- POST /api/internal/reminders/admission-30min). That endpoint sends a WhatsApp
-- reminder ONCE — this column is the idempotency guard so a Cloud Tasks retry
-- (at-least-once delivery) never re-sends the reminder.
--
-- reminder_task_name already exists (252) for eventual cancellation; this adds
-- the "already delivered" timestamp.
--
-- Idempotent: safe to re-run (ADD COLUMN IF NOT EXISTS).
-- ================================================================

ALTER TABLE admission_appointments
  ADD COLUMN IF NOT EXISTS reminder_30min_sent_at TIMESTAMPTZ;

COMMENT ON COLUMN admission_appointments.reminder_30min_sent_at IS
  'When the 30-minute-before WhatsApp reminder was delivered. NULL = not yet sent. Set by POST /api/internal/reminders/admission-30min; used as the idempotency guard against Cloud Tasks at-least-once retries. Migration 253.';

COMMIT;
