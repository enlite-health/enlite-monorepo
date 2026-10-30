-- ROLLBACK_552_078_pedidos_ia_cells.sql — par de rollback da migration 552 (células pedidos_ia:*, spec 078).
-- Só roda apontando o caminho (o runner não lê `pending/`). Remove vínculos de grupo (se a operação já concedeu) e as células.
-- Se a 552 estiver em schema_migrations, remover a linha à mão para poder reaplicar.
DELETE FROM iam.group_permissions WHERE permission_id IN (SELECT id FROM iam.permissions WHERE resource = 'pedidos_ia');
DELETE FROM iam.permissions WHERE resource = 'pedidos_ia';
