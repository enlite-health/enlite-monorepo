-- Migration 172: add source column to whatsapp_bulk_dispatch_logs
-- Purpose: track origin of each WhatsApp dispatch (bulk, individual, outbox)
-- Strategy: fully idempotent via IF NOT EXISTS + conditional constraint add

ALTER TABLE whatsapp_bulk_dispatch_logs ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'bulk';

-- Add CHECK constraint only when it does not already exist (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_bulk_dispatch_logs_source_check'
  ) THEN
    ALTER TABLE whatsapp_bulk_dispatch_logs
      ADD CONSTRAINT whatsapp_bulk_dispatch_logs_source_check
      CHECK (source IN ('bulk', 'individual', 'outbox'));
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_whatsapp_logs_source
  ON whatsapp_bulk_dispatch_logs(source);
