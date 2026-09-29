-- Migration 486: permissão `ai_prompt` (read, update, restore) — spec 029
--
-- POR QUÊ explícito, não sync: a sincronização automática do catálogo de permissões está
-- DESLIGADA em produção (fatos-medidos.md §9 da spec 029). Sem esta migration inserindo as
-- células e concedendo-as, a tela de prompts de IA sobe e ninguém consegue abrir — não há boot
-- que resolva isso sozinho. Molde do INSERT:
-- migrations/435_split_write_grants_create_update.sql:59-83 (seed de iam.permissions) e
-- migrations/436_iam_master_grants_all_active_cells.sql (grant direto ao Acesso Master).
--
-- TRÊS ações (data-model.md §Permissão):
--   ai_prompt:read    → ler conteúdo e histórico, comparar versões
--   ai_prompt:update  → salvar, testar e desfazer a última alteração
--   ai_prompt:restore → restaurar QUALQUER versão do histórico (separada de update por decisão
--                        do Gabriel, 29/09: reverter o próprio erro é diferente de saltar para
--                        um ponto arbitrário do passado, que exige saber qual versão era boa)
--
-- Concedidas ao grupo `Acesso Master` (UUID fixo a0000000-0000-0000-0000-000000000001, seed 206).
-- A distribuição para outros grupos ou pessoas é da operação, fora desta entrega (data-model.md).
--
-- Idempotente: ON CONFLICT DO NOTHING nos dois passos. Sem BEGIN/COMMIT explícito — cada
-- statement já é atômico e o `DO` é a unidade transacional mínima necessária.

DO $$
DECLARE
  v_master_id CONSTANT UUID := 'a0000000-0000-0000-0000-000000000001';
BEGIN
  IF to_regclass('iam.permissions') IS NOT NULL THEN
    -- 1. Semear as 3 células no catálogo (idempotente via UNIQUE(resource, action) da 206).
    INSERT INTO iam.permissions (resource, action, description, category, owner_service, deprecated_at)
    VALUES
      ('ai_prompt', 'read',
       'Ler o conteúdo e o histórico dos prompts de IA da plataforma, e comparar versões.',
       'Administração', 'worker-functions', NULL),
      ('ai_prompt', 'update',
       'Salvar, testar (preview) e desfazer a última alteração de um prompt de IA.',
       'Administração', 'worker-functions', NULL),
      ('ai_prompt', 'restore',
       'Restaurar qualquer versão anterior do histórico de um prompt de IA.',
       'Administração', 'worker-functions', NULL)
    ON CONFLICT (resource, action) DO NOTHING;

    -- 2. Conceder as 3 ao Acesso Master, explicitamente — não depende do boot da 436
    --    (iam.grant_active_permissions_to_master), porque o sync que o alimenta está
    --    desligado em produção.
    INSERT INTO iam.group_permissions (group_id, permission_id)
    SELECT v_master_id, p.id
      FROM iam.permissions p
     WHERE p.resource = 'ai_prompt'
    ON CONFLICT DO NOTHING;
  END IF;

  -- Espelho em public.* só se for tabela física (PRD ainda no seed 206 cru), mesmo guard das
  -- migrations 432/435/436.
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'permissions' AND c.relkind = 'r'
  ) THEN
    INSERT INTO public.permissions (resource, action, description, category)
    VALUES
      ('ai_prompt', 'read',
       'Ler o conteúdo e o histórico dos prompts de IA da plataforma, e comparar versões.',
       'Administração'),
      ('ai_prompt', 'update',
       'Salvar, testar (preview) e desfazer a última alteração de um prompt de IA.',
       'Administração'),
      ('ai_prompt', 'restore',
       'Restaurar qualquer versão anterior do histórico de um prompt de IA.',
       'Administração')
    ON CONFLICT (resource, action) DO NOTHING;

    INSERT INTO public.group_permissions (group_id, permission_id)
    SELECT v_master_id, p.id
      FROM public.permissions p
     WHERE p.resource = 'ai_prompt'
    ON CONFLICT DO NOTHING;
  END IF;
END
$$;
