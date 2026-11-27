-- ROLLBACK_597_077_coordination_alert.sql — par de rollback da migration 597 (emenda 077 §5.3).
-- Mora em `migrations/pending/`; só roda quando alguém aponta o caminho. Perde o histórico de alertas emitidos (a idempotência recomeça).
BEGIN;
DROP TABLE IF EXISTS coordination_alert_delivery;
DROP TABLE IF EXISTS coordination_alert;
-- Os tipos só somem se nenhum evento os usa (FK):
DELETE FROM notification_types WHERE code IN ('PRESENCE_OPEN_4H', 'CHECK_IN_REFUSED_NO_ENTRY')
  AND NOT EXISTS (SELECT 1 FROM notification_events e WHERE e.type_code = notification_types.code);
COMMIT;
