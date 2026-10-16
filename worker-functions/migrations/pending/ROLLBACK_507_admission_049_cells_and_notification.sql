-- ROLLBACK_507_admission_049_cells_and_notification.sql — par de rollback da migration 507 (spec 049).
-- Mora em `migrations/pending/`; só roda quando alguém aponta o caminho. Ordem inversa: 507, 506, 505, 504, 503.
DELETE FROM iam.group_permissions
 WHERE permission_id IN (SELECT id FROM iam.permissions WHERE resource IN ('patient_admission', 'own_tactiq_link'));
DELETE FROM iam.permissions WHERE resource IN ('patient_admission', 'own_tactiq_link');
-- O tipo de notificação só some se nenhum evento o usa (FK):
DELETE FROM notification_types WHERE code = 'ADMISSION_TACTIQ_LINK_REQUIRED'
  AND NOT EXISTS (SELECT 1 FROM notification_events WHERE type_code = 'ADMISSION_TACTIQ_LINK_REQUIRED');
