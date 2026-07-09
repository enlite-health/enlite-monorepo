-- Migration 237: coluna channel em messaging_outbox (histórico + teto diário Periskope)
--
-- CONTEXTO: workers.messaging_channel é mutável (worker pode flipar de twilio
-- para periskope via handover a qualquer momento) — para o teto diário de
-- envios Periskope (guardrail de pacing) e para auditoria histórica precisa
-- ("este envio de 3 dias atrás foi twilio ou periskope?"), o outbox precisa
-- do canal RESOLVIDO no momento do envio, não o canal atual do worker.
-- Por isso a coluna nasce aqui em vez de resolver via JOIN em workers.
--
-- OutboxProcessor grava esta coluna junto com status='sent'.
-- Idempotente: IF NOT EXISTS em todas as DDLs.

ALTER TABLE messaging_outbox
  ADD COLUMN IF NOT EXISTS channel VARCHAR(20) NOT NULL DEFAULT 'twilio';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'messaging_outbox_channel_check'
  ) THEN
    ALTER TABLE messaging_outbox
      ADD CONSTRAINT messaging_outbox_channel_check
      CHECK (channel IN ('twilio', 'periskope'));
  END IF;
END;
$$;

COMMENT ON COLUMN messaging_outbox.channel IS
  'Canal efetivamente usado no envio desta mensagem (resolvido no momento do '
  'processamento via COALESCE(worker canônico, worker), não o canal atual do '
  'worker). Usado pelo guardrail de teto diário do Periskope em OutboxProcessor.';

-- Índice parcial: guardrail de teto diário consulta apenas sent+periskope+hoje.
CREATE INDEX IF NOT EXISTS idx_messaging_outbox_periskope_sent_daily
  ON messaging_outbox(channel, processed_at)
  WHERE status = 'sent' AND channel = 'periskope';
