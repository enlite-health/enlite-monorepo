-- Migration 223: Adiciona coluna de tracking do lembrete 5min em worker_job_applications
--
-- interview_reminder_sent_at (24h) já existe desde mig 099.
-- Esta migration adiciona interview_reminder_5min_sent_at para permitir que o
-- processBatch() do ReminderScheduler use WJA (não encuadres) como SSOT.
--
-- Aditiva — sem DROP, sem NOT NULL sem default.

ALTER TABLE worker_job_applications
  ADD COLUMN IF NOT EXISTS interview_reminder_5min_sent_at TIMESTAMPTZ;

DO $$ BEGIN
  RAISE NOTICE 'Migration 223 done: interview_reminder_5min_sent_at added to worker_job_applications.';
END $$;
