-- 514 — Reintentar resumen (spec 050, F11, R-38): 1 célula nova, concedida ao Acesso Master e ao grupo 'Admisión y Supervisión'.
--
--   patient_admission:retry_summary   (autoriza +1 rodada de até 3 chamadas pagas do resumo; ação que GASTA, como o reenviar)
--
-- Molde 509/507: placeholder ANTES do grant (esta migration roda ANTES do sync do catálogo no boot, que depois sobrescreve a
-- descrição sem trocar o id). A 507 concede por RECURSO e só roda uma vez: esta migration concede a célula nova por conta própria,
-- aos dois grupos (id fixo do Master; nome EXATO 'Admisión y Supervisión', ausente na stage = 0 linhas). Nunca remove grant,
-- nunca cria/move/reativa grupo. A autorização em si é um EVENTO da trilha (`summary_retry_authorized`, 504) — sem tabela nova.
--
-- Sem BEGIN/COMMIT próprio (o runner já envolve). Idempotente (2×).
-- ROLLBACK: migrations/pending/ROLLBACK_514_admission_050_retry_summary_cell.sql

DO $$
DECLARE
  v_master_id CONSTANT UUID := 'a0000000-0000-0000-0000-000000000001';
  v_n INT;
BEGIN
  IF to_regclass('iam.permissions') IS NOT NULL THEN
    INSERT INTO iam.permissions (resource, action, description, category, owner_service, deprecated_at)
    VALUES
      ('patient_admission', 'retry_summary',
       '[514 placeholder — sincronizado no boot] Autorizar uma nova rodada do resumo da reunião de admissão (até 3 chamadas pagas).',
       'Pacientes', 'worker-functions', NULL)
    ON CONFLICT (resource, action) DO NOTHING;
  END IF;

  IF to_regclass('iam.permission_groups') IS NOT NULL AND to_regclass('iam.group_permissions') IS NOT NULL THEN
    INSERT INTO iam.group_permissions (group_id, permission_id)
    SELECT v_master_id, p.id
      FROM iam.permissions p
     WHERE p.resource = 'patient_admission' AND p.action = 'retry_summary' AND p.deprecated_at IS NULL
       AND EXISTS (SELECT 1 FROM iam.permission_groups g WHERE g.id = v_master_id)
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE '[514] grant ao Acesso Master: % célula patient_admission:retry_summary', v_n;

    INSERT INTO iam.group_permissions (group_id, permission_id)
    SELECT g.id, p.id
      FROM iam.permission_groups g
      CROSS JOIN iam.permissions p
     WHERE g.name IN ('Admisión y Supervisión')
       AND g.archived_at IS NULL
       AND p.resource = 'patient_admission' AND p.action = 'retry_summary' AND p.deprecated_at IS NULL
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE '[514] grant a Admisión y Supervisión: % célula patient_admission:retry_summary', v_n;
  END IF;
END
$$;
