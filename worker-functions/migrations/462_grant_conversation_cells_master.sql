-- 462 — Grant explícito ao Acesso Master das 7 células da spec 022 (D-23, T132)
--
-- POR QUÊ: Gabriel pediu por escrito (citação em tasks.md D-22/D-23): "essa funcionalidade
-- precisa entrar no ABAC ... inserir a autorização direto no grupo MASTER". O catch-up
-- automático da migration 436 (`iam.grant_active_permissions_to_master()`, chamado a cada boot
-- com `PERMISSION_CATALOG_SYNC_ENABLED=true`) JÁ cobriria isto sozinho (medido em
-- `evidencias/b1-matriz-abac.md`: as 4 células de `patient_conversation` já apareceram no Master
-- via auto-grant, sem esta migration) — mas a instrução pede a migration explícita mesmo assim.
-- Esta migration é REDUNDANTE com o catch-up automático quando ele já rodou, e por isso é
-- inofensiva (idempotente, `ON CONFLICT DO NOTHING`, nunca `DELETE`).
--
-- Adiada do B1 para o B4 (tasks.md, nota "Adiada para o B4" de T132): das 7 células, 5
-- (`patient_conversation:read|create|update|delete`, `staff_directory:read`) já existiam no B1;
-- as 2 restantes (`own_notifications:read|update`) só passam a existir no catálogo quando as
-- rotas do sino (T405/T406, Bloco 4) são montadas e o boot sincroniza o catálogo. Rodar esta
-- migration antes disso concederia só 5 e nunca voltaria pelas 2 — migration roda UMA vez,
-- registrada em `schema_migrations` (D-16).
--
-- O QUE NÃO FAZ: não mexe em nenhum outro grupo (D285 intacta para eles); nunca remove grant.
--
-- ROLLBACK: `DELETE FROM iam.group_permissions WHERE group_id = 'a0000000-0000-0000-0000-000000000001'
-- AND permission_id IN (SELECT id FROM iam.permissions WHERE resource IN ('patient_conversation',
-- 'staff_directory', 'own_notifications'))`. Nenhuma linha de `iam.permissions` é tocada.

BEGIN;

DO $$
DECLARE
  v_master_id CONSTANT UUID := 'a0000000-0000-0000-0000-000000000001';
  v_n INT;
BEGIN
  IF to_regclass('iam.permission_groups') IS NOT NULL THEN
    INSERT INTO iam.group_permissions (group_id, permission_id)
    SELECT v_master_id, p.id
      FROM iam.permissions p
     WHERE p.resource IN ('patient_conversation', 'staff_directory', 'own_notifications')
       AND p.deprecated_at IS NULL
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE '[462] grant explícito ao Acesso Master: % células novas (spec 022, D-23)', v_n;
  END IF;
END
$$;

COMMIT;
