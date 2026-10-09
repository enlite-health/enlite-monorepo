-- 507 — Aba Admissão (spec 049, F1): 5 células novas + tipo de notificação do vínculo do Tactiq
--
-- Células (placeholder ANTES do grant — molde 497/502; esta migration roda ANTES do sync do catálogo no boot, que depois
-- sobrescreve a descrição sem trocar o id):
--   patient_admission:read | write | resend_message   (aba Admissão do paciente)
--   own_tactiq_link:read | write                      (o operador vê/gerencia o PRÓPRIO vínculo — célula own_*)
-- Grant SÓ ao Acesso Master. O grupo "Admisión y Supervisión" NÃO recebe: quais perfis recebem é decisão do Diego (H7).
-- Nunca remove grant, nunca cria/move/reativa grupo.
--
-- Tipo de notificação: ADMISSION_TACTIQ_LINK_REQUIRED (aviso no sino: "seu usuário não está vinculado ao Tactiq").
--
-- Idempotente (2×). ROLLBACK: migrations/pending/ROLLBACK_507_admission_049_cells_and_notification.sql

BEGIN;

INSERT INTO notification_types (code, description) VALUES
  ('ADMISSION_TACTIQ_LINK_REQUIRED',
   'Aviso automático: o responsável de admissão não tem o Tactiq vinculado (ou o vínculo caiu / é de outra conta)')
ON CONFLICT (code) DO NOTHING;

DO $$
DECLARE
  v_master_id CONSTANT UUID := 'a0000000-0000-0000-0000-000000000001';
  v_n INT;
BEGIN
  IF to_regclass('iam.permissions') IS NOT NULL THEN
    INSERT INTO iam.permissions (resource, action, description, category, owner_service, deprecated_at)
    VALUES
      ('patient_admission', 'read',
       '[507 placeholder — sincronizado no boot] Ver a aba Admissão do paciente: agendas, selos de mensagem e resumo.',
       'Pacientes', 'worker-functions', NULL),
      ('patient_admission', 'write',
       '[507 placeholder — sincronizado no boot] Criar e cancelar agenda de admissão pelo painel.',
       'Pacientes', 'worker-functions', NULL),
      ('patient_admission', 'resend_message',
       '[507 placeholder — sincronizado no boot] Reenviar o WhatsApp da reunião de admissão que falhou.',
       'Pacientes', 'worker-functions', NULL),
      ('own_tactiq_link', 'read',
       '[507 placeholder — sincronizado no boot] Ver o estado do PRÓPRIO vínculo com o Tactiq.',
       'Administração', 'worker-functions', NULL),
      ('own_tactiq_link', 'write',
       '[507 placeholder — sincronizado no boot] Vincular ou desvincular a PRÓPRIA conta do Tactiq.',
       'Administração', 'worker-functions', NULL)
    ON CONFLICT (resource, action) DO NOTHING;
  END IF;

  IF to_regclass('iam.permission_groups') IS NOT NULL AND to_regclass('iam.group_permissions') IS NOT NULL THEN
    INSERT INTO iam.group_permissions (group_id, permission_id)
    SELECT v_master_id, p.id
      FROM iam.permissions p
     WHERE p.resource IN ('patient_admission', 'own_tactiq_link') AND p.deprecated_at IS NULL
       AND EXISTS (SELECT 1 FROM iam.permission_groups g WHERE g.id = v_master_id)
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE '[507] grant ao Acesso Master: % células patient_admission/own_tactiq_link', v_n;
  END IF;
END
$$;

COMMIT;
