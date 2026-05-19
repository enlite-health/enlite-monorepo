-- ============================================================
-- Migration 170: Add batch_id to bulk dispatch and outbox tables
--
-- Allows grouping messages sent in the same bulk dispatch run
-- for tracing and analytics purposes.
-- ============================================================

ALTER TABLE whatsapp_bulk_dispatch_logs ADD COLUMN IF NOT EXISTS batch_id UUID NULL;
ALTER TABLE messaging_outbox ADD COLUMN IF NOT EXISTS batch_id UUID NULL;

CREATE INDEX IF NOT EXISTS idx_bulk_dispatch_logs_batch
  ON whatsapp_bulk_dispatch_logs(batch_id) WHERE batch_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messaging_outbox_batch
  ON messaging_outbox(batch_id) WHERE batch_id IS NOT NULL;
