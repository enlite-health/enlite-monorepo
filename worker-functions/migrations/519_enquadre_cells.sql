-- 519 — Células do evento de enquadre (spec 052, Fase 2): 4 células novas, concedidas SÓ ao Acesso Master.
--
--   enquadre_event:read      (listar e ver eventos)
--   enquadre_event:create    (ver prestadores/entrevistadores/horários livres e criar evento)
--   enquadre_event:update    (acrescentar/tirar convocado e cancelar evento)
--   enquadre_result:update   (marcar resultado no evento e encerrar)
--
-- Molde 509: placeholder ANTES do grant (esta migration roda ANTES do sync do catálogo no boot, que depois sobrescreve a
-- descrição sem trocar o id). Concedida só ao Acesso Master (id fixo, igual à 507/509): dar as células aos demais grupos é decisão
-- da operação. Nunca remove grant, nunca cria/move/reativa grupo.
--
-- Idempotente (2×). ROLLBACK: migrations/pending/ROLLBACK_519_enquadre_cells.sql

BEGIN;

DO $$
DECLARE
  v_master_id CONSTANT UUID := 'a0000000-0000-0000-0000-000000000001';
  v_n INT;
BEGIN
  IF to_regclass('iam.permissions') IS NOT NULL THEN
    INSERT INTO iam.permissions (resource, action, description, category, owner_service, deprecated_at)
    VALUES
      ('enquadre_event', 'read',
       '[519 placeholder — sincronizado no boot] Ver os eventos de enquadre de uma vaga e seus convocados.',
       'Vagas e Funil', 'worker-functions', NULL),
      ('enquadre_event', 'create',
       '[519 placeholder — sincronizado no boot] Criar um evento de enquadre (escolher entrevistadora, horário e prestadores).',
       'Vagas e Funil', 'worker-functions', NULL),
      ('enquadre_event', 'update',
       '[519 placeholder — sincronizado no boot] Acrescentar ou tirar convocado e cancelar um evento de enquadre.',
       'Vagas e Funil', 'worker-functions', NULL),
      ('enquadre_result', 'update',
       '[519 placeholder — sincronizado no boot] Marcar o resultado de cada prestador no evento de enquadre e encerrá-lo.',
       'Vagas e Funil', 'worker-functions', NULL)
    ON CONFLICT (resource, action) DO NOTHING;
  END IF;

  IF to_regclass('iam.permission_groups') IS NOT NULL AND to_regclass('iam.group_permissions') IS NOT NULL THEN
    INSERT INTO iam.group_permissions (group_id, permission_id)
    SELECT v_master_id, p.id
      FROM iam.permissions p
     WHERE ((p.resource = 'enquadre_event' AND p.action IN ('read', 'create', 'update'))
         OR (p.resource = 'enquadre_result' AND p.action = 'update'))
       AND p.deprecated_at IS NULL
       AND EXISTS (SELECT 1 FROM iam.permission_groups g WHERE g.id = v_master_id)
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE '[519] grant ao Acesso Master: % células do enquadre (spec 052)', v_n;
  END IF;
END
$$;

COMMIT;
