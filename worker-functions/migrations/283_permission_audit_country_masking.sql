-- 283_permission_audit_country_masking.sql
--
-- POR QUÊ: `iam.query_audit` (280) filtra só por `tenant_id`. Um auditor com
-- escopo de país AR consegue ler o `resource_id` de um registro BR — furando o
-- isolamento que esta change existe para construir (lex 0.2, condição M2-5).
--
-- COMO **NÃO** consertar: filtrando a linha inteira por país. Isso cegaria
-- justamente o controle que a trilha serve — se o auditor AR não VÊ que alguém
-- acessou um registro BR, o acesso cross-país (a violação que o isolamento
-- impede) some do radar de quem tem a função de detectá-la. A Ley 25.326 art. 9
-- exige medidas que "permitan detectar desviaciones"; suprimir a linha faz o
-- oposto.
--
-- COMO consertar: MASCARAR O CAMPO, mantendo o registro — que é o padrão de
-- redação em nível de campo em trilha de auditoria (ISO 27001 A.12.4; NIST
-- SP 800-92 tratam log como registro protegido com acesso restrito, não como
-- registro a apagar por leitor). O auditor fora do escopo vê que o acesso
-- ocorreu, a quê e por quem — sem o identificador do titular.
--
-- Para isso a linha precisa saber a que país pertence. Coluna nova `country`,
-- NULL-ável: preenchida com o país do CONTEXTO da request (`app.user_country` /
-- `currentDbContext().country`). Sob a RLS de país, o contexto é o país das
-- linhas que a request pode tocar — então é proxy fiel do país do recurso, e é
-- o que a trilha de fato pode afirmar com honestidade.
--
-- Custo zero agora: a tabela está VAZIA em todo ambiente (documentado na 280).
--
-- Regra de mascaramento (fail-closed para auditor com escopo):
--   · auditor que cobre TODOS os países suportados  → vê tudo (é o caso de hoje:
--     `permission_management:read` só existe em Acesso Master / Super Admin);
--   · auditor com escopo restrito → vê `resource_id` só das linhas do(s) seu(s)
--     país(es); o resto vira o sentinela '<oculto>' — sentinela, e não NULL, para
--     o auditor saber que houve ocultação em vez de achar que não havia id.

ALTER TABLE iam.permission_audit_log ADD COLUMN IF NOT EXISTS country VARCHAR(2);

COMMENT ON COLUMN iam.permission_audit_log.country IS
  'País do CONTEXTO da request (app.user_country) no momento da decisão. NULL = '
  'contexto sem país (caminho de sistema, ou antes da RLS de país). Usado para '
  'mascarar resource_id fora do escopo do auditor em iam.query_audit (lex M2-5).';

-- Países suportados. Espelha a constante `COUNTRIES` de
-- scripts/set-staff-country-claim.ts — se um país novo entrar lá, entra aqui.
CREATE OR REPLACE FUNCTION iam.supported_countries()
RETURNS TEXT[] LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$ SELECT ARRAY['AR', 'BR'] $$;

REVOKE ALL ON FUNCTION iam.supported_countries() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT EXECUTE ON FUNCTION iam.supported_countries() TO app_runtime, app_system;
  END IF;
END
$$;

-- A função devolve SETOF do tipo da tabela → depende do rowtype; recriar.
DROP FUNCTION IF EXISTS iam.query_audit(varchar,varchar,timestamptz,timestamptz,int);

CREATE FUNCTION iam.query_audit(p_user_id VARCHAR, p_resource VARCHAR, p_since TIMESTAMPTZ, p_until TIMESTAMPTZ, p_limit INT)
RETURNS SETOF iam.permission_audit_log
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, iam, public
AS $$
DECLARE
  v_actor     VARCHAR := iam._actor();
  v_tenant    UUID    := iam.current_tenant_id();
  v_countries TEXT[];
  v_global    BOOLEAN;
BEGIN
  IF v_actor IS NULL OR NOT ('permission_management:read' = ANY (iam.effective_permissions(v_actor, v_tenant))) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = '[iam] permission_management:read ausente';
  END IF;

  v_countries := iam.effective_countries(v_actor, v_tenant);
  -- Cobre todos os países suportados ⇒ não há "fora do escopo" a ocultar.
  v_global := iam.supported_countries() <@ COALESCE(v_countries, ARRAY[]::TEXT[]);

  -- O ato de auditar continua sendo auditado (280).
  INSERT INTO iam.permission_audit_log (tenant_id, user_id, resource, action, resource_id, decision)
  VALUES (v_tenant, v_actor, 'permission_audit', 'read', COALESCE(p_user_id, p_resource), 'ALLOW');

  RETURN QUERY
    SELECT a.id,
           a.tenant_id,
           a.user_id,
           a.resource,
           a.action,
           CASE
             WHEN v_global THEN a.resource_id
             WHEN a.country IS NOT NULL AND a.country = ANY (COALESCE(v_countries, ARRAY[]::TEXT[]))
               THEN a.resource_id
             WHEN a.resource_id IS NULL THEN NULL
             ELSE '<oculto>'
           END,
           a.decision,
           a.ip_address,
           a.created_at,
           a.country
    FROM iam.permission_audit_log a
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

-- View de compatibilidade acompanha a coluna nova (SELECT-only; a 280 já revoga
-- escrita — e view simples é auto-atualizável, então a REVOKE importa).
CREATE OR REPLACE VIEW public.permission_audit_log AS SELECT * FROM iam.permission_audit_log;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    REVOKE ALL ON public.permission_audit_log FROM app_runtime, app_system;
  END IF;
END
$$;
