-- Migration 598: otp_send_events + rate_limit_counters (spec 077 emenda OTP, B2/B3/G2).
--
-- Regras da casa: idempotente (roda 2x, tudo com IF NOT EXISTS), sem controle de transação próprio (o runner envolve) e
-- sem alterar privilégios (roda como enlite_app, o dono das tabelas).
-- Rollback: `migrations/pending/ROLLBACK_598_otp_send_events_e_rate_limit_counters.sql` (perde só contadores e trilha de envio).

CREATE TABLE IF NOT EXISTS rate_limit_counters (
  key      TEXT PRIMARY KEY,                       -- prefix:sha256(chave do limitador); nunca uid/IP cru
  hits     INTEGER NOT NULL CHECK (hits >= 0),
  reset_at TIMESTAMPTZ NOT NULL                    -- fim da janela corrente (vigência do contador)
);
COMMENT ON TABLE rate_limit_counters IS 'Contador de janela fixa dos limitadores por conta (express-rate-limit Store). Dono único do conceito "pedidos na janela". Chave com hash; sem PII.';

CREATE TABLE IF NOT EXISTS otp_send_events (
  id               BIGSERIAL PRIMARY KEY,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  challenge_id     TEXT NOT NULL,                  -- id devolvido pelo adapter (UUID do próprio ou VE… do Verify)
  adapter          TEXT NOT NULL CHECK (adapter IN ('own', 'verify')),
  purpose          TEXT NOT NULL CHECK (purpose IN ('claim', 'link', 'phone_verify')),
  requester_hash   TEXT NOT NULL,                  -- sha256(uid do token que pediu o envio), hex 64
  target_worker_id UUID REFERENCES workers(id) ON DELETE CASCADE,
  suppressed       BOOLEAN NOT NULL,               -- FR-95: ficha de teste, nada saiu pelo Twilio
  CONSTRAINT otp_send_events_target_por_adapter CHECK ((adapter = 'verify') = (target_worker_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_otp_send_events_dia ON otp_send_events (created_at) WHERE NOT suppressed;
CREATE INDEX IF NOT EXISTS idx_otp_send_events_challenge ON otp_send_events (challenge_id);
COMMENT ON TABLE otp_send_events IS 'Dono do conceito "envio de OTP pedido por alguém" (teto global, vínculo desafio→requisitante). O código vive em otp_challenges (adapter own) ou na Twilio (verify).';
COMMENT ON COLUMN otp_send_events.target_worker_id IS 'Só no adapter verify (sem linha em otp_challenges). NULL = adapter own: a ficha é otp_challenges.worker_id do mesmo challenge_id (derivação, nunca cópia).';
