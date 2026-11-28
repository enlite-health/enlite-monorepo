-- ROLLBACK_598_otp_send_events_e_rate_limit_counters.sql — par de rollback da migration 598.
-- Mora em `migrations/pending/`; só roda quando alguém aponta o caminho. Perde só contadores de limite e a trilha de envio de OTP.
BEGIN;
DROP TABLE IF EXISTS otp_send_events;
DROP TABLE IF EXISTS rate_limit_counters;
COMMIT;
