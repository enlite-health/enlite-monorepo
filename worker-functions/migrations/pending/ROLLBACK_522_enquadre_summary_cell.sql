-- ROLLBACK_522_enquadre_summary_cell.sql — par de rollback da migration 522 (spec 052, Fase 3).
-- Mora em `migrations/pending/`; só roda quando alguém aponta o caminho. Tira a célula e seus grants (a concessão a grupos feita
-- depois pela operação também cai, pois a célula deixa de existir).
DELETE FROM iam.group_permissions
 WHERE permission_id IN (SELECT id FROM iam.permissions WHERE resource = 'enquadre_summary' AND action = 'read');
DELETE FROM iam.permissions WHERE resource = 'enquadre_summary' AND action = 'read';
