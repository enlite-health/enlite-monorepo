-- ROLLBACK_555_081_recruitment_activity_per_person_cell.sql — par de rollback da migration 555 (spec 081, T064).
-- Só roda apontando o caminho (o runner não lê `pending/`). Remove o vínculo com o Acesso Master e a célula.
-- Se a 555 estiver em schema_migrations, remover a linha à mão para poder reaplicar.
DELETE FROM iam.group_permissions WHERE permission_id IN (SELECT id FROM iam.permissions WHERE resource = 'recruitment_activity_per_person');
DELETE FROM iam.permissions WHERE resource = 'recruitment_activity_per_person';
