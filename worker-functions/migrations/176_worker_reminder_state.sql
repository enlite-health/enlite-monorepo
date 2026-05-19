-- Migration 176: worker_reminder_state
-- Lock atomic por worker+template+dia para bulk dispatch idempotente.
-- INSERT ON CONFLICT DO NOTHING adquire slot; UPDATE registra resultado.
-- Retenção 30 dias (purge via runbook Fase 7).

CREATE TABLE IF NOT EXISTS worker_reminder_state (
  worker_id     UUID         NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  template_slug VARCHAR(100) NOT NULL,
  sent_date     DATE         NOT NULL DEFAULT CURRENT_DATE,
  status        VARCHAR(20)  NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'sent', 'failed')),
  batch_id      UUID         NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (worker_id, template_slug, sent_date)
);

CREATE INDEX IF NOT EXISTS idx_worker_reminder_state_date
  ON worker_reminder_state(sent_date DESC);

CREATE INDEX IF NOT EXISTS idx_worker_reminder_state_batch
  ON worker_reminder_state(batch_id) WHERE batch_id IS NOT NULL;

COMMENT ON TABLE worker_reminder_state IS
  'Lock atomic por worker+template+dia. INSERT ON CONFLICT DO NOTHING adquire slot. UPDATE registra resultado. Retencao 30 dias.';

-- Backfill: rows de hoje em whatsapp_bulk_dispatch_logs viram ''sent'' aqui
-- Evita reenvio massivo em pós-deploy quando a tabela ainda está vazia.
INSERT INTO worker_reminder_state (worker_id, template_slug, sent_date, status)
SELECT DISTINCT worker_id, template_slug, dispatched_at::date, 'sent'
FROM whatsapp_bulk_dispatch_logs
WHERE worker_id IS NOT NULL
  AND dispatched_at::date = CURRENT_DATE
ON CONFLICT (worker_id, template_slug, sent_date) DO NOTHING;
