-- ROLLBACK_514_admission_050_retry_summary_cell.sql — par de rollback da migration 514 (spec 050 F11).
-- Mora em `migrations/pending/`; só roda quando alguém aponta o caminho. As autorizações já gravadas ficam na trilha (só-acréscimo).
DELETE FROM iam.group_permissions
 WHERE permission_id IN (SELECT id FROM iam.permissions WHERE resource = 'patient_admission' AND action = 'retry_summary');
DELETE FROM iam.permissions WHERE resource = 'patient_admission' AND action = 'retry_summary';
