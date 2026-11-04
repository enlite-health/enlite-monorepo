-- ROLLBACK_559_083_admission_import_blocked_notification.sql — par de rollback da migration 559 (spec 083).
-- Mora em `migrations/pending/`; só roda quando alguém aponta o caminho.
-- O tipo só some se nenhum evento o usa (FK):
DELETE FROM notification_types WHERE code = 'ADMISSION_IMPORT_BLOCKED'
  AND NOT EXISTS (SELECT 1 FROM notification_events WHERE type_code = 'ADMISSION_IMPORT_BLOCKED');
