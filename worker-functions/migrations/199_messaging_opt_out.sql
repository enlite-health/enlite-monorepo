-- Migration 199: messaging_opt_out
-- Tabela de opt-out de mensagens WhatsApp. Requisito Meta Business API:
-- destinatários devem poder parar de receber mensagens (PARAR/STOP).
-- Também armazena motivo de opt-out (spam report, user request, admin).

CREATE TABLE IF NOT EXISTS messaging_opt_out (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id     UUID         NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  phone         VARCHAR(20)  NOT NULL,
  reason        VARCHAR(50)  NOT NULL DEFAULT 'user_request'
                  CHECK (reason IN ('user_request', 'admin', 'undelivered_cap')),
  source        VARCHAR(50)  NOT NULL DEFAULT 'whatsapp_inbound',
  opted_out_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  opted_in_at   TIMESTAMPTZ  NULL,
  CONSTRAINT uq_messaging_opt_out_worker UNIQUE (worker_id)
);

CREATE INDEX IF NOT EXISTS idx_messaging_opt_out_phone
  ON messaging_opt_out(phone) WHERE opted_in_at IS NULL;

COMMENT ON TABLE messaging_opt_out IS
  'Opt-out de mensagens WhatsApp. opted_in_at NULL = ativo. Requisito Meta Business API.';
