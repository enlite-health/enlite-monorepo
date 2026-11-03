-- Migration 557: decidir pedidos da IA é só do grupo decisor (Marcel), não do Acesso Master (spec 078, M7)
--
-- Pedido do Gabriel (03/11): "SÓ O MARCEL pode aprovar, rejeitar ou aprovar com comentário".
--
--   1. `iam.grant_active_permissions_to_master()` (436, chamada a cada boot pelo sync do catálogo) passa a PULAR a célula
--      `pedidos_ia:decidir`. O resto da função é idêntico ao da 436 (SECURITY DEFINER, mesmo gate `app.system_context`,
--      INSERT idempotente). Sem isto o sync do boot devolveria a célula ao Master no deploy seguinte.
--   2. Remove o vínculo `pedidos_ia:decidir` do Acesso Master (UUID fixo a0000000-...-01). `pedidos_ia:read` continua no Master.
--      A célula deixa de ser master-only (código: `SOMENTE_ACESSO_MASTER_CELLS`): a operação cria o grupo "Decisor de
--      pedidos IA" só com o Marcel e concede a célula pelo painel. NENHUM grupo é criado nem concedido por esta migration.
--   3. `agentes.pedido_eventos.comentario` JÁ EXISTE (551, usada por `descrever`, CHECK 1..500). "Aprovar com comentário"
--      grava o comentário no evento `aceitar` na MESMA coluna; o teto do CHECK sobe de 500 para 1000 (a API do `descrever`
--      continua limitando a 500). Nenhuma coluna nova.
--
-- Idempotente (2x). Sem BEGIN/COMMIT próprio (o runner envolve).
-- Rollback: `migrations/pending/ROLLBACK_557_078_pedidos_ia_decidir_fora_do_master.sql`.

-- ── 1. Função de boot sem a célula decidir ────────────────────────────────────────────────────────
DO $outer$
BEGIN
  IF to_regclass('iam.permission_groups') IS NOT NULL THEN
    EXECUTE $ddl$
      CREATE OR REPLACE FUNCTION iam.grant_active_permissions_to_master()
      RETURNS INT
      LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = pg_catalog, iam, public
      AS $fn$
      DECLARE
        v_master_id CONSTANT UUID := 'a0000000-0000-0000-0000-000000000001';
        v_n INT;
      BEGIN
        IF NOT iam._is_system_context() THEN
          RAISE EXCEPTION USING ERRCODE = '42501',
            MESSAGE = '[iam] conceder ao Acesso Master exige app.system_context declarado';
        END IF;

        INSERT INTO iam.group_permissions (group_id, permission_id)
        SELECT v_master_id, p.id
          FROM iam.permissions p
         WHERE p.deprecated_at IS NULL
           AND NOT (p.resource = 'pedidos_ia' AND p.action = 'decidir')  -- 557: decisor é grupo próprio (Marcel)
        ON CONFLICT DO NOTHING;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        RETURN v_n;
      END;
      $fn$
    $ddl$;

    EXECUTE $c$COMMENT ON FUNCTION iam.grant_active_permissions_to_master() IS
      'D338: o Acesso Master (id fixo) recebe automaticamente toda célula ATIVA do catálogo, a cada sync de boot, '
      'EXCETO pedidos_ia:decidir (557: decidir pedido da IA é do grupo decisor, concedido pela operação). '
      'INSERT idempotente (ON CONFLICT DO NOTHING) — nunca remove grant, nunca concede a outro grupo.'$c$;
  END IF;
END
$outer$;

-- ── 2. Tira o vínculo decidir do Acesso Master ────────────────────────────────────────────────────
DO $$
DECLARE
  v_n INT;
BEGIN
  IF to_regclass('iam.group_permissions') IS NOT NULL AND to_regclass('iam.permissions') IS NOT NULL THEN
    DELETE FROM iam.group_permissions gp
     USING iam.permissions p
     WHERE gp.permission_id = p.id
       AND gp.group_id = 'a0000000-0000-0000-0000-000000000001'
       AND p.resource = 'pedidos_ia' AND p.action = 'decidir';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE '[557] pedidos_ia:decidir removida do Acesso Master: % vínculo(s)', v_n;
  END IF;
END
$$;

-- ── 3. Comentário do `aceitar` cabe em 1000 caracteres (a coluna já existe desde a 551) ───────────
DO $$
BEGIN
  IF to_regclass('agentes.pedido_eventos') IS NOT NULL THEN
    ALTER TABLE agentes.pedido_eventos DROP CONSTRAINT IF EXISTS pedido_eventos_comentario_check;
    ALTER TABLE agentes.pedido_eventos
      ADD CONSTRAINT pedido_eventos_comentario_check CHECK (char_length(comentario) BETWEEN 1 AND 1000);
  END IF;
END
$$;
