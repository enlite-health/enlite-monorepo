-- 522 — Quinta célula do enquadre (spec 052, Fase 3): enquadre_summary:read, concedida SÓ ao Acesso Master.
--
--   enquadre_summary:read   (ver o selo do resumo do evento de enquadre e baixar o resumo em PDF)
--
-- Sem a célula a API do evento omite o campo do resumo e o selo, e a rota do download responde 403. Dar a célula a outros grupos é decisão da operação, nunca desta migration.
--
-- Molde 519: placeholder ANTES do grant (a migration roda ANTES do sync do catálogo no boot, que depois sobrescreve a descrição sem
-- trocar o id). Concedida só ao Acesso Master (id fixo). Nunca remove grant, nunca cria/move/reativa grupo.
--
-- Idempotente (2×). ROLLBACK: migrations/pending/ROLLBACK_522_enquadre_summary_cell.sql

BEGIN;

DO $$
DECLARE
  v_master_id CONSTANT UUID := 'a0000000-0000-0000-0000-000000000001';
  v_n INT;
BEGIN
  IF to_regclass('iam.permissions') IS NOT NULL THEN
    INSERT INTO iam.permissions (resource, action, description, category, owner_service, deprecated_at)
    VALUES
      ('enquadre_summary', 'read',
       '[522 placeholder — sincronizado no boot] Ver o selo do resumo do evento de enquadre e baixar o resumo (PDF).',
       'Vagas e Funil', 'worker-functions', NULL)
    ON CONFLICT (resource, action) DO NOTHING;
  END IF;

  IF to_regclass('iam.permission_groups') IS NOT NULL AND to_regclass('iam.group_permissions') IS NOT NULL THEN
    INSERT INTO iam.group_permissions (group_id, permission_id)
    SELECT v_master_id, p.id
      FROM iam.permissions p
     WHERE p.resource = 'enquadre_summary' AND p.action = 'read'
       AND p.deprecated_at IS NULL
       AND EXISTS (SELECT 1 FROM iam.permission_groups g WHERE g.id = v_master_id)
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE '[522] grant ao Acesso Master: % célula do resumo do enquadre (spec 052)', v_n;
  END IF;
END
$$;

COMMIT;
