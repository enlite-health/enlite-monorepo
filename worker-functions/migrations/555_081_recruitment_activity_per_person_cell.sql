-- Migration 555: célula da atividade do funil POR RECRUTADORA (spec 081, T064, D602a)
--
--   recruitment_activity_per_person:read  Ver contagens de atividade do funil por recrutadora e semana
--
-- Concessão SÓ ao Acesso Master (a0000000-0000-0000-0000-000000000001), molde 550: o sync do catálogo
-- de permissões está desligado em produção, então a concessão é semeada AQUI. Nenhum outro grupo
-- (recrutadoras não recebem — `SOMENTE_ACESSO_MASTER_CELLS` recusa em 422 a concessão a outro grupo).
-- Idempotente (2x). Sem BEGIN/COMMIT próprio (o runner envolve).
-- Rollback: `migrations/pending/ROLLBACK_555_081_recruitment_activity_per_person_cell.sql`.

DO $$
DECLARE
  v_master_id CONSTANT UUID := 'a0000000-0000-0000-0000-000000000001';
BEGIN
  IF to_regclass('iam.permissions') IS NOT NULL THEN
    INSERT INTO iam.permissions (resource, action, description, category, owner_service, deprecated_at)
    VALUES
      ('recruitment_activity_per_person', 'read',
       '[555 placeholder — sincronizado no boot] Ver a atividade do funil de recrutamento POR RECRUTADORA e por semana (só contagens).',
       'Operações', 'worker-functions', NULL)
    ON CONFLICT (resource, action) DO NOTHING;

    INSERT INTO iam.group_permissions (group_id, permission_id)
    SELECT v_master_id, p.id
      FROM iam.permissions p
     WHERE p.resource = 'recruitment_activity_per_person' AND p.action = 'read'
    ON CONFLICT DO NOTHING;
  END IF;

  -- Espelho em public.* só se for tabela física (mesmo guard da 550).
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'permissions' AND c.relkind = 'r'
  ) THEN
    INSERT INTO public.permissions (resource, action, description, category)
    VALUES
      ('recruitment_activity_per_person', 'read',
       '[555 placeholder — sincronizado no boot] Ver a atividade do funil de recrutamento POR RECRUTADORA e por semana (só contagens).',
       'Operações')
    ON CONFLICT (resource, action) DO NOTHING;

    INSERT INTO public.group_permissions (group_id, permission_id)
    SELECT v_master_id, p.id
      FROM public.permissions p
     WHERE p.resource = 'recruitment_activity_per_person' AND p.action = 'read'
    ON CONFLICT DO NOTHING;
  END IF;
END
$$;
