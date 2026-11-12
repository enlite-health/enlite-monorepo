-- Migration 552: células da página de pedidos do Sol (spec 078, M3b-1)
--
--   pedidos_ia:read     Ver os pedidos do Sol e dos gestores
--   pedidos_ia:decidir  Aceitar, negar ou redirecionar um pedido
--
-- Placeholder ANTES do sync do catálogo no boot (molde 507): o sync sobrescreve a descrição sem trocar o id.
-- SEM `iam.group_permissions`: o grupo "Decisores de pedidos IA" é da OPERAÇÃO (nunca criar/mover/conceder grupo por migration).
-- Até a operação conceder, só quem tem o papel ADMIN passa (família `admin.integrations`, `untilEnforced: 'admin'`).
-- Idempotente (2x). Sem BEGIN/COMMIT próprio (o runner envolve).
-- Rollback: `migrations/pending/ROLLBACK_552_078_pedidos_ia_cells.sql`.

DO $$
BEGIN
  IF to_regclass('iam.permissions') IS NOT NULL THEN
    INSERT INTO iam.permissions (resource, action, description, category, owner_service, deprecated_at)
    VALUES
      ('pedidos_ia', 'read',
       '[552 placeholder — sincronizado no boot] Ver os pedidos do Sol e dos gestores.',
       'Operações', 'worker-functions', NULL),
      ('pedidos_ia', 'decidir',
       '[552 placeholder — sincronizado no boot] Aceitar, negar ou redirecionar um pedido.',
       'Operações', 'worker-functions', NULL)
    ON CONFLICT (resource, action) DO NOTHING;
  END IF;
END
$$;
