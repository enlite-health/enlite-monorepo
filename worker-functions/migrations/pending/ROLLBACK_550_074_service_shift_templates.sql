-- ROLLBACK_550_074_service_shift_templates.sql — par de rollback da migration 550
-- (catálogo de guardias predefinidas, spec 074).
--
-- Mora em `migrations/pending/` (sem número) porque o runner só lê `migrations/` sem recursão;
-- um `551_rollback_*` seria aplicado sozinho na próxima corrida. Só roda quando alguém aponta o
-- caminho explicitamente:
--   ./scripts/run-migration-prod.sh worker-functions/migrations/pending/ROLLBACK_550_074_service_shift_templates.sql
--
-- Sem trava de FK: nada referencia o catálogo por desenho (aplicar copia os horários).

-- Células ABAC: grants primeiro, depois as permissões.
DO $$
BEGIN
  IF to_regclass('iam.permissions') IS NOT NULL THEN
    DELETE FROM iam.group_permissions
     WHERE permission_id IN (SELECT id FROM iam.permissions WHERE resource = 'catalog_service_shift_templates');
    DELETE FROM iam.permissions WHERE resource = 'catalog_service_shift_templates';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'permissions' AND c.relkind = 'r'
  ) THEN
    DELETE FROM public.group_permissions
     WHERE permission_id IN (SELECT id FROM public.permissions WHERE resource = 'catalog_service_shift_templates');
    DELETE FROM public.permissions WHERE resource = 'catalog_service_shift_templates';
  END IF;
END $$;

DROP TABLE IF EXISTS service_shift_template_items;
DROP TABLE IF EXISTS service_shift_templates;
DROP FUNCTION IF EXISTS fn_service_shift_templates_code();
DROP FUNCTION IF EXISTS shift_template_day_minutes(time, int);
