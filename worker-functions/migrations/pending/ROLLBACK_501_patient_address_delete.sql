-- ROLLBACK_501_patient_address_delete.sql — par de rollback da migration 501 (remover Localización, spec 044).
--
-- Mora em `migrations/pending/` (sem número): só roda quando alguém aponta o caminho explicitamente.
--   ./scripts/run-migration-prod.sh worker-functions/migrations/pending/ROLLBACK_501_patient_address_delete.sql
--
-- ATENÇÃO: derrubar a trilha apaga o registro de quem removeu cada endereço. Reverter o código (rota DELETE)
-- antes, senão o DELETE passa a falhar (a auditoria é obrigatória na mesma transação).
DELETE FROM iam.group_permissions
 WHERE permission_id IN (SELECT id FROM iam.permissions WHERE resource = 'patient_address' AND action = 'delete');
DELETE FROM iam.permissions WHERE resource = 'patient_address' AND action = 'delete';
DROP TABLE IF EXISTS patient_address_audit_log;
