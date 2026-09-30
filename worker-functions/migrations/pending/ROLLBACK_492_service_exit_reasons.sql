-- ROLLBACK_492_service_exit_reasons.sql — par de rollback da migration 492
-- (catálogo de motivos de saída do serviço, change itinerario-trocas-motivos-e-figma, Fase 1).
--
-- Mora em `migrations/pending/` (sem número) porque o runner só lê `migrations/` sem recursão;
-- um `493_rollback_*` seria aplicado sozinho na próxima corrida. Só roda quando alguém aponta o
-- caminho explicitamente:
--   ./scripts/run-migration-prod.sh worker-functions/migrations/pending/ROLLBACK_492_service_exit_reasons.sql
--
-- Trava de dado: se alguma tabela referencia `service_exit_reasons(code)` por FK (a partir da
-- Fase 2 haverá), o rollback apagaria o que aponta para o catálogo — recusa.

DO $$
DECLARE
  v_ref TEXT;
BEGIN
  IF to_regclass('public.service_exit_reasons') IS NOT NULL THEN
    SELECT string_agg(conrelid::regclass::text || '.' || conname, ', ')
      INTO v_ref
      FROM pg_constraint
     WHERE contype = 'f' AND confrelid = 'public.service_exit_reasons'::regclass;
    IF v_ref IS NOT NULL THEN
      RAISE EXCEPTION 'service_exit_reasons é referenciada por FK (%) — o rollback quebraria as marcas (OK do Gabriel antes)', v_ref;
    END IF;
  END IF;
END $$;

DROP TABLE IF EXISTS service_exit_reasons;
DROP FUNCTION IF EXISTS fn_service_exit_reasons_code();

DO $$
BEGIN
  IF to_regclass('iam.permissions') IS NOT NULL THEN
    DELETE FROM iam.group_permissions
     WHERE permission_id IN (SELECT id FROM iam.permissions WHERE resource = 'catalog_service_exit_reasons');
    DELETE FROM iam.permissions WHERE resource = 'catalog_service_exit_reasons';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'permissions' AND c.relkind = 'r'
  ) THEN
    DELETE FROM public.group_permissions
     WHERE permission_id IN (SELECT id FROM public.permissions WHERE resource = 'catalog_service_exit_reasons');
    DELETE FROM public.permissions WHERE resource = 'catalog_service_exit_reasons';
  END IF;
END $$;
