-- 509 — Ensaio pago por reunião (spec 050, F3, R-19): 1 célula nova, concedida SÓ ao Acesso Master.
--
--   patient_admission:release_paid_rehearsal   (libera UMA reunião de paciente de teste por 48 h no caminho pago)
--
-- Placeholder ANTES do grant (molde 507): esta migration roda ANTES do sync do catálogo no boot, que depois sobrescreve a
-- descrição sem trocar o id. Concedida só ao Acesso Master (id fixo, igual à 507). NÃO vai ao grupo 'Admisión y Supervisión':
-- a conta do e2e-prod e a operação do dia a dia não podem liberar custo (R-19). Nunca remove grant, nunca cria/move/reativa grupo.
-- A liberação em si é um EVENTO da trilha (`admission_events`, 504) — sem tabela nova.
--
-- Idempotente (2×). ROLLBACK: migrations/pending/ROLLBACK_509_admission_050_release_paid_rehearsal_cell.sql

BEGIN;

DO $$
DECLARE
  v_master_id CONSTANT UUID := 'a0000000-0000-0000-0000-000000000001';
  v_n INT;
BEGIN
  IF to_regclass('iam.permissions') IS NOT NULL THEN
    INSERT INTO iam.permissions (resource, action, description, category, owner_service, deprecated_at)
    VALUES
      ('patient_admission', 'release_paid_rehearsal',
       '[509 placeholder — sincronizado no boot] Liberar o ensaio pago de uma reunião de admissão de paciente de teste, por 48 h.',
       'Pacientes', 'worker-functions', NULL)
    ON CONFLICT (resource, action) DO NOTHING;
  END IF;

  IF to_regclass('iam.permission_groups') IS NOT NULL AND to_regclass('iam.group_permissions') IS NOT NULL THEN
    INSERT INTO iam.group_permissions (group_id, permission_id)
    SELECT v_master_id, p.id
      FROM iam.permissions p
     WHERE p.resource = 'patient_admission' AND p.action = 'release_paid_rehearsal' AND p.deprecated_at IS NULL
       AND EXISTS (SELECT 1 FROM iam.permission_groups g WHERE g.id = v_master_id)
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE '[509] grant ao Acesso Master: % célula patient_admission:release_paid_rehearsal', v_n;
  END IF;
END
$$;

COMMIT;
