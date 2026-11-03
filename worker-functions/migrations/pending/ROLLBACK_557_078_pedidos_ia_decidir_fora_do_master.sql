-- ROLLBACK_557_078_pedidos_ia_decidir_fora_do_master.sql — par de rollback da migration 557.
-- Só roda apontando o caminho (o runner não lê `pending/`). Se a 557 estiver em schema_migrations, remover a linha à mão.
-- 1. Restaura a função da 436 (Master recebe toda célula ativa); 2. devolve `pedidos_ia:decidir` ao Acesso Master;
-- 3. volta o teto do comentário para 500 (FALHA se já houver `aceitar` com comentário > 500: apagar/encurtar antes, à mão).
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
  SELECT v_master_id, p.id FROM iam.permissions p WHERE p.deprecated_at IS NULL
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$fn$;

INSERT INTO iam.group_permissions (group_id, permission_id)
SELECT 'a0000000-0000-0000-0000-000000000001', p.id FROM iam.permissions p
 WHERE p.resource = 'pedidos_ia' AND p.action = 'decidir'
ON CONFLICT DO NOTHING;

ALTER TABLE agentes.pedido_eventos DROP CONSTRAINT IF EXISTS pedido_eventos_comentario_check;
ALTER TABLE agentes.pedido_eventos
  ADD CONSTRAINT pedido_eventos_comentario_check CHECK (char_length(comentario) BETWEEN 1 AND 500);
