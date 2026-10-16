-- ROLLBACK_519_enquadre_cells.sql — par de rollback da migration 519 (spec 052, Fase 2).
-- Mora em `migrations/pending/`; só roda quando alguém aponta o caminho. Tira as 4 células e seus grants (a concessão a grupos
-- feita depois pela operação também cai, pois a célula deixa de existir).
DELETE FROM iam.group_permissions
 WHERE permission_id IN (SELECT id FROM iam.permissions
                          WHERE (resource = 'enquadre_event' AND action IN ('read', 'create', 'update'))
                             OR (resource = 'enquadre_result' AND action = 'update'));
DELETE FROM iam.permissions
 WHERE (resource = 'enquadre_event' AND action IN ('read', 'create', 'update'))
    OR (resource = 'enquadre_result' AND action = 'update');
