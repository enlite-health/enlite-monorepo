-- 280: iam.permission_audit_log particionada + retenção + SELECT-revogado (lex C6)
--
-- POR QUÊ: a trilha de DECISÃO (DENY sempre; ALLOW em PII/paciente/documento/delete/
-- export — D-P4) vai receber escrita real a partir do engine (grupo 3). A tabela da
-- 206 é plana, sem retenção e com SELECT aberto às roles do app. O lex (C6) exige o
-- mesmo padrão da 270: partição mensal, append-only, SELECT só por função de
-- auditoria gated (iam.query_audit, 279), retenção 6 anos (alinhada ao
-- resource_access_log — 45 CFR 164.316(b)(2)(i)) e purge por partição.
--
-- COMO: Postgres não converte tabela plana em particionada in-place. A tabela está
-- VAZIA em todo ambiente (nenhum escritor até hoje — grep 16/08) → estratégia
-- segura e re-rodável: se ainda não é particionada, renomeia a antiga para
-- `permission_audit_log_legacy`, cria a particionada com o MESMO nome e colunas
-- (PK (id, created_at) — chave de partição precisa estar na PK), copia o que houver,
-- dropa a legacy. `iam.query_audit` (279) devolve SETOF desta tabela e fica presa ao
-- OID antigo (o DROP da legacy falharia por dependência — provado no probe): a função
-- é dropada antes e recriada no fim, mesma assinatura/corpo.
--
-- Retenção: janela de partições 2026-01 → 2032-12 (7 anos de colchão) + DEFAULT.
-- Purge = DROP da partição com > 6 anos (runbook, ato registrado). Nunca DELETE.
-- Sem PII de titular: só identificadores (uid do staff, resource_id, IP do staff).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'iam' AND c.relname = 'permission_audit_log' AND c.relkind = 'r'   -- 'r' = plana
  ) THEN
    -- iam.query_audit (279) devolve SETOF desta tabela → depende do OID; dropar antes
    -- (é recriada no fim desta migration, mesma assinatura).
    DROP FUNCTION IF EXISTS iam.query_audit(varchar,varchar,timestamptz,timestamptz,int);
    ALTER TABLE iam.permission_audit_log RENAME TO permission_audit_log_legacy;
    -- índices da 206 levam o nome junto; renomear para não colidir com os novos
    ALTER INDEX IF EXISTS iam.idx_permission_audit_user_date       RENAME TO idx_pal_legacy_user_date;
    ALTER INDEX IF EXISTS iam.idx_permission_audit_resource_action RENAME TO idx_pal_legacy_resource_action;
    ALTER INDEX IF EXISTS iam.idx_permission_audit_tenant_date     RENAME TO idx_pal_legacy_tenant_date;
    -- a view de compatibilidade da 274 aponta para a tabela pelo OID → seguiria a
    -- legacy; recriamos abaixo apontando para a nova
    DROP VIEW IF EXISTS public.permission_audit_log;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS iam.permission_audit_log (
  id          UUID         NOT NULL DEFAULT gen_random_uuid(),
  tenant_id   UUID         NOT NULL REFERENCES iam.tenants(id),
  user_id     VARCHAR(128) NOT NULL,
  resource    VARCHAR(100) NOT NULL,
  action      VARCHAR(50)  NOT NULL,
  resource_id TEXT,
  decision    VARCHAR(10)  NOT NULL CHECK (decision IN ('ALLOW', 'DENY')),
  ip_address  INET,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

COMMENT ON TABLE iam.permission_audit_log IS
  'Trilha de DECISÃO de permissão (DENY sempre; ALLOW em PII/paciente/documento/delete/'
  'export — D-P4). Append-only; SELECT só via iam.query_audit (gated). Partições mensais + '
  'DEFAULT; retenção 6 anos, purge por DROP de partição (runbook). Só identificadores.';

DO $$
DECLARE
  m DATE := DATE '2026-01-01';
  part_name TEXT;
BEGIN
  WHILE m < DATE '2033-01-01' LOOP
    part_name := 'permission_audit_log_' || to_char(m, 'YYYY_MM');
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS iam.%I PARTITION OF iam.permission_audit_log FOR VALUES FROM (%L) TO (%L)',
      part_name, m, m + INTERVAL '1 month'
    );
    m := m + INTERVAL '1 month';
  END LOOP;
END
$$;
CREATE TABLE IF NOT EXISTS iam.permission_audit_log_default
  PARTITION OF iam.permission_audit_log DEFAULT;

CREATE INDEX IF NOT EXISTS idx_permission_audit_user_date
  ON iam.permission_audit_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_permission_audit_resource_action
  ON iam.permission_audit_log (resource, action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_permission_audit_tenant_date
  ON iam.permission_audit_log (tenant_id, created_at DESC);

-- Copia o que houver na legacy (esperado: 0 linhas) e a remove.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'iam' AND c.relname = 'permission_audit_log_legacy'
  ) THEN
    INSERT INTO iam.permission_audit_log (id, tenant_id, user_id, resource, action, resource_id, decision, ip_address, created_at)
    SELECT id, tenant_id, user_id, resource, action, resource_id, decision, ip_address, created_at
    FROM iam.permission_audit_log_legacy;
    DROP TABLE iam.permission_audit_log_legacy;
  END IF;
END
$$;

-- View de compatibilidade recriada (SELECT-only; herda a REVOKE abaixo via invoker).
CREATE OR REPLACE VIEW public.permission_audit_log AS SELECT * FROM iam.permission_audit_log;
COMMENT ON VIEW public.permission_audit_log IS
  'Compatibilidade (mig 274/280): a tabela vive em iam.permission_audit_log (particionada). '
  'Leitura só via iam.query_audit; esta view não tem SELECT para as roles do app.';

-- ── Privilégios: append-only, SELECT revogado (mãe E partições, presentes e futuras) ──
DO $$
DECLARE
  p RECORD;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    REVOKE ALL ON iam.permission_audit_log FROM app_runtime, app_system;
    GRANT INSERT ON iam.permission_audit_log TO app_runtime, app_system;
    REVOKE ALL ON public.permission_audit_log FROM app_runtime, app_system;
    FOR p IN
      SELECT c.relname FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      WHERE i.inhparent = 'iam.permission_audit_log'::regclass
    LOOP
      EXECUTE format('REVOKE ALL ON iam.%I FROM app_runtime, app_system', p.relname);
      EXECUTE format('GRANT INSERT ON iam.%I TO app_runtime, app_system', p.relname);
    END LOOP;
    -- Partição futura criada por operação: o default privilege da 274 concederia
    -- SELECT/UPDATE/DELETE → o e2e (1.9) trava drift: toda partição de
    -- permission_audit_log tem que estar INSERT-only para as roles do app.
  END IF;
END
$$;

-- iam.query_audit (279) referencia SETOF iam.permission_audit_log — recriar para
-- amarrar ao OID novo (mesma assinatura e corpo; idempotente).
CREATE OR REPLACE FUNCTION iam.query_audit(p_user_id VARCHAR, p_resource VARCHAR, p_since TIMESTAMPTZ, p_until TIMESTAMPTZ, p_limit INT)
RETURNS SETOF iam.permission_audit_log
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, iam, public
AS $$
DECLARE
  v_actor VARCHAR := iam._actor();
  v_tenant UUID := iam.current_tenant_id();
BEGIN
  IF v_actor IS NULL OR NOT ('permission_management:read' = ANY (iam.effective_permissions(v_actor, v_tenant))) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = '[iam] permission_management:read ausente';
  END IF;
  INSERT INTO iam.permission_audit_log (tenant_id, user_id, resource, action, resource_id, decision)
  VALUES (v_tenant, v_actor, 'permission_audit', 'read', COALESCE(p_user_id, p_resource), 'ALLOW');
  RETURN QUERY
    SELECT * FROM iam.permission_audit_log a
    WHERE a.tenant_id = v_tenant
      AND (p_user_id  IS NULL OR a.user_id  = p_user_id)
      AND (p_resource IS NULL OR a.resource = p_resource)
      AND (p_since    IS NULL OR a.created_at >= p_since)
      AND (p_until    IS NULL OR a.created_at <  p_until)
    ORDER BY a.created_at DESC
    LIMIT LEAST(COALESCE(p_limit, 200), 1000);
END;
$$;
DO $$
BEGIN
  REVOKE ALL ON FUNCTION iam.query_audit(varchar,varchar,timestamptz,timestamptz,int) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT EXECUTE ON FUNCTION iam.query_audit(varchar,varchar,timestamptz,timestamptz,int) TO app_runtime, app_system;
  END IF;
END
$$;
