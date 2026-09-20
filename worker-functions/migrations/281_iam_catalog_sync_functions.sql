-- 281: sincronização do CATÁLOGO de células por função SECURITY DEFINER (D115, design 1b)
--
-- POR QUÊ: o catálogo de permissões é DERIVADO do código — a rota declara a célula que
-- exige (`requirePermission`) e o boot sincroniza `iam.permissions`. Só que a 274 revoga
-- INSERT/UPDATE em `iam.permissions` das roles do app (a mesma regra que impede a role
-- confinada de forjar o próprio grant), e a 279 não trouxe função de catálogo — ela cobriu
-- grupos, países, membros e features. Sem estas duas funções o `syncCatalog()` do grupo 2
-- não teria como escrever, e a alternativa (GRANT INSERT em iam.permissions para
-- app_runtime) abriria justamente o que a 274 fechou: quem escreve no catálogo escolhe
-- quais células existem — e uma célula inventada é uma permissão que ninguém governa.
--
-- GATE (mesmo padrão do iam.sync_country_feature_default da 279):
--   · ACL — EXECUTE só para `app_system` (checada contra o CHAMADOR, mesmo em SECURITY
--     DEFINER; dentro da função `current_user` é o DONO, ver BLOCKER do gate #223);
--   · GUC — `app.system_context` declarado (é sincronização de BOOT, nunca ação de staff).
--
-- FAIL-CLOSED do descontinuar: `deprecate_missing_permission_cells` com lista VAZIA
-- levanta exceção. Uma varredura que voltou vazia (router ainda não montado, flag errada,
-- bug no scanner) descontinuaria o catálogo INTEIRO — e célula descontinuada some de
-- `iam.effective_permissions`, ou seja, todo staff perderia todo acesso no boot seguinte.
-- Nunca apagamos linha: `deprecated_at` preserva o histórico dos grupos que já a usavam.

-- Upsert de UMA célula declarada. Devolve o que aconteceu, para o log do boot.
CREATE OR REPLACE FUNCTION iam.sync_permission_cell(
  p_resource      VARCHAR,
  p_action        VARCHAR,
  p_description   TEXT,
  p_category      VARCHAR,
  p_owner_service VARCHAR
)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, iam, public
AS $$
DECLARE
  v_prev iam.permissions%ROWTYPE;
BEGIN
  IF NOT iam._is_system_context() THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = '[iam] sync do catálogo exige app.system_context declarado';
  END IF;

  SELECT * INTO v_prev FROM iam.permissions WHERE resource = p_resource AND action = p_action;

  INSERT INTO iam.permissions (resource, action, description, category, owner_service, deprecated_at)
  VALUES (p_resource, p_action, p_description, p_category, COALESCE(p_owner_service, 'worker-functions'), NULL)
  ON CONFLICT (resource, action) DO UPDATE
    SET category      = EXCLUDED.category,
        owner_service = EXCLUDED.owner_service,
        -- descrição do seed 206 é melhor que a do código: só sobrescreve se veio algo
        description   = COALESCE(EXCLUDED.description, iam.permissions.description),
        deprecated_at = NULL;   -- declarada de novo → volta a valer

  IF v_prev.resource IS NULL THEN RETURN 'inserted'; END IF;
  IF v_prev.deprecated_at IS NOT NULL THEN RETURN 'revived'; END IF;
  RETURN 'unchanged';
END;
$$;
COMMENT ON FUNCTION iam.sync_permission_cell(VARCHAR, VARCHAR, TEXT, VARCHAR, VARCHAR) IS
  'Upsert de célula DECLARADA no código (catálogo derivado, design 1b). Só contexto de '
  'sistema; ACL só app_system. Reviver = limpar deprecated_at.';

-- Descontinua as células DESTE serviço que sumiram do código. Nunca apaga.
CREATE OR REPLACE FUNCTION iam.deprecate_missing_permission_cells(
  p_owner_service VARCHAR,
  p_live_keys     TEXT[]
)
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, iam, public
AS $$
DECLARE
  v_n INT;
BEGIN
  IF NOT iam._is_system_context() THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = '[iam] descontinuar célula exige app.system_context declarado';
  END IF;
  IF p_live_keys IS NULL OR cardinality(p_live_keys) = 0 THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = '[iam] lista de células vivas VAZIA — descontinuaria o catálogo inteiro (fail-closed)';
  END IF;

  UPDATE iam.permissions p
     SET deprecated_at = now()
   WHERE COALESCE(p.owner_service, 'worker-functions') = COALESCE(p_owner_service, 'worker-functions')
     AND p.deprecated_at IS NULL
     AND NOT ((p.resource || ':' || p.action) = ANY (p_live_keys));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;
COMMENT ON FUNCTION iam.deprecate_missing_permission_cells(VARCHAR, TEXT[]) IS
  'Marca deprecated_at nas células do serviço que sumiram das declarações. Lista vazia = '
  'exceção (uma varredura falha tiraria o acesso de todo mundo). Nunca DELETE.';

DO $$
DECLARE
  f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'iam.sync_permission_cell(varchar,varchar,text,varchar,varchar)',
    'iam.deprecate_missing_permission_cells(varchar,text[])'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
      -- Gate por ROLE = ACL: o pool de SISTEMA sincroniza o catálogo; app_runtime,
      -- mesmo forjando app.system_context, não consegue nem chamar.
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM app_runtime', f);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO app_system', f);
    END IF;
  END LOOP;
END
$$;
