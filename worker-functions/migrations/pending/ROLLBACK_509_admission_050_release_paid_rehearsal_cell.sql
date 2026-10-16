-- ROLLBACK_509_admission_050_release_paid_rehearsal_cell.sql — par de rollback da migration 509 (spec 050 F3).
-- Mora em `migrations/pending/`; só roda quando alguém aponta o caminho. As liberações já gravadas ficam na trilha (só-acréscimo).
DELETE FROM iam.group_permissions
 WHERE permission_id IN (SELECT id FROM iam.permissions WHERE resource = 'patient_admission' AND action = 'release_paid_rehearsal');
DELETE FROM iam.permissions WHERE resource = 'patient_admission' AND action = 'release_paid_rehearsal';
