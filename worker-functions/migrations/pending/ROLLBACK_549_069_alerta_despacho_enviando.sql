-- ROLLBACK_549_069_alerta_despacho_enviando.sql — par de rollback da migration 549 (spec 069, D2c).
-- Só roda se alguém apontar o caminho (o runner não lê `pending/`). Devolve 'SENDING' a 'PENDING' (tentável de novo) e restaura a CHECK da 548.
UPDATE itinerary_uncovered_alert_dispatch SET email_status = 'PENDING' WHERE email_status = 'SENDING';
ALTER TABLE itinerary_uncovered_alert_dispatch DROP CONSTRAINT IF EXISTS itinerary_uncovered_alert_dispatch_email_status_check;
ALTER TABLE itinerary_uncovered_alert_dispatch
  ADD CONSTRAINT itinerary_uncovered_alert_dispatch_email_status_check
  CHECK (email_status IN ('PENDING','SENT','FAILED','SKIPPED_TEST','SKIPPED_NO_KEY','NO_ADDRESS'));
