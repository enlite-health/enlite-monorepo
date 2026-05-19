-- ============================================================
-- Migration 171: Add trace_id to messaging_outbox and domain_events
--
-- Enables distributed tracing: Processors read trace_id from the row
-- and inject it into loggingAls context. NULL for legacy rows (pre-Phase 3).
-- ============================================================

ALTER TABLE messaging_outbox ADD COLUMN IF NOT EXISTS trace_id TEXT NULL;
ALTER TABLE domain_events ADD COLUMN IF NOT EXISTS trace_id TEXT NULL;
