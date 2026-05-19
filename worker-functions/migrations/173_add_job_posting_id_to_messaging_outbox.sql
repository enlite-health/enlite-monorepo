-- ============================================================
-- Migration 173: Add job_posting_id to messaging_outbox
--
-- Enables idempotency check and traceability for vacancy-scoped
-- outbox messages (e.g., auto-invite after match).
-- Index covers the 7-day dedup window for (worker, vacancy, template).
-- ============================================================

ALTER TABLE messaging_outbox
  ADD COLUMN IF NOT EXISTS job_posting_id UUID NULL REFERENCES job_postings(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_messaging_outbox_worker_job_template
  ON messaging_outbox(worker_id, job_posting_id, template_slug)
  WHERE job_posting_id IS NOT NULL;
