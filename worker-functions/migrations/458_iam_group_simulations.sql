-- 458 — Spec 026: simular grupo de acesso (só Acesso Master), D407
--
-- POR QUÊ: hoje o único jeito de ver "o que este grupo enxerga" é o gestor ENTRAR no grupo
-- (mudar filiação real) ou pedir para outra pessoa testar — nenhum dos dois é auditável nem
-- reversível sozinho. Esta migration dá ao Acesso Master um período de tempo em que
-- `effective_permissions`/`effective_countries` decidem pelo grupo SIMULADO, sem tocar a
-- filiação real (`iam.user_groups`) — troca = fechar a simulação aberta + abrir outra; nunca
-- soma. `data-model.md` (spec 026) é a fonte; §Princípio: SET ROLE dentro do iam é o desenho.
--
-- ORDEM (aditiva, uma transação):
--   1. tabela iam.group_simulations (histórico; nunca DELETE) — GRANT só SELECT a app_runtime,
--      escrita exclusiva pelas writer functions (§6), molde `iam.user_groups` (274/275).
--   2. iam.is_master_member(uid) extraída de iam._require_master_membership (456:66-103);
--      _require_master_membership passa a chamá-la — comportamento IDÊNTICO (os 12 testes de
--      master-group-self-managed-guard.e2e.test.ts continuam verdes).
--   3. iam.active_group_simulation (o ÚNICO lugar com o predicado "ativa") e iam.acting_groups
--      (COALESCE: simulação SUBSTITUI os grupos reais, nunca soma).
--   4. iam.effective_permissions/iam.effective_countries (276) trocam a fonte de grupos por
--      iam.acting_groups — todos os demais filtros (status ACTIVE, archived_at, deprecated_at,
--      revoked_at, tenant, DISTINCT, ORDER BY) ficam byte-a-byte iguais à 276.
--   5. iam.permission_audit_log ganha simulation_id (283 recriada com a coluna na lista
--      explícita — a função depende do rowtype da tabela, por isso DROP+CREATE, não OR REPLACE).
--   6. writers iam.start_group_simulation / iam.end_group_simulation (molde 279/456: SECURITY
--      DEFINER, search_path fixo, ator por iam._actor(), tenant por iam.current_tenant_id()).
--
-- ROLLBACK: worker-functions/migrations/pending/ROLLBACK_458_iam_group_simulations.sql (T1.7) —
-- reaponta effective_permissions/effective_countries para iam.user_groups (texto da 276), recria
-- query_audit da 283, e NÃO dropa tabela nem coluna (constituição VI: nada apaga).
--
-- TRILHA: OP-21 em docs/legal/registro-operacoes.md (T1.6) — finalidade "conferência de
-- permissões de grupo por membro do Acesso Master (simulação)"; C1 do parecer de privacidade
-- (lex-veredito.md) redigida 22/09/2026.

BEGIN;

-- ── 1. Tabela ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS iam.group_simulations (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID         NOT NULL REFERENCES iam.tenants(id),
  user_id      VARCHAR(128) NOT NULL REFERENCES users(firebase_uid),   -- ator REAL (nunca o grupo simulado)
  group_id     UUID         NOT NULL REFERENCES iam.permission_groups(id), -- grupo EFETIVO durante a simulação
  started_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ  NOT NULL,
  ended_at     TIMESTAMPTZ,      -- NULL enquanto aberta
  ended_reason VARCHAR(16),      -- NULL enquanto aberta; USER | SUPERSEDED | EXPIRED ao fechar
  CONSTRAINT group_simulations_expires_after_started_ck CHECK (expires_at > started_at),
  CONSTRAINT group_simulations_ended_reason_ck
    CHECK (ended_reason IS NULL OR ended_reason IN ('USER', 'SUPERSEDED', 'EXPIRED')),
  CONSTRAINT group_simulations_ended_pair_ck
    CHECK ((ended_at IS NULL) = (ended_reason IS NULL))
);

-- No máximo 1 simulação ABERTA por (tenant, ator) — é o índice que active_group_simulation usa
-- (molde uq_user_groups_live, 275:57-58).
CREATE UNIQUE INDEX IF NOT EXISTS uq_group_simulations_live
  ON iam.group_simulations (tenant_id, user_id) WHERE ended_at IS NULL;
-- "quem simulou este grupo, quando" — trilha por grupo.
CREATE INDEX IF NOT EXISTS ix_group_simulations_group_started
  ON iam.group_simulations (group_id, started_at);

COMMENT ON TABLE iam.group_simulations IS
  'Spec 026 (D407): período em que o Acesso Master simula OUTRO grupo — effective_permissions/'
  'effective_countries decidem pelo grupo simulado (group_id), nunca pelos reais do ator, '
  'enquanto ended_at IS NULL AND expires_at > now(). Troca = fecha a aberta + abre outra; nunca '
  'soma. Nunca DELETE — histórico. Trilha em iam.permission_audit_log.simulation_id e OP-21 '
  '(docs/legal/registro-operacoes.md).';
COMMENT ON COLUMN iam.group_simulations.user_id IS
  'Ator REAL (o membro do Acesso Master que simula) — nunca o grupo simulado.';
COMMENT ON COLUMN iam.group_simulations.group_id IS
  'Grupo simulado (o que passa a decidir). Nunca o Acesso Master (guard na writer function).';

-- SELECT-only para as roles do app (molde iam.user_groups, 274:147-149) — escrita É exclusiva
-- das writer functions SECURITY DEFINER (§6); nenhum caminho grava iam.group_simulations direto.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
      ON iam.group_simulations FROM app_runtime, app_system;
  END IF;
END
$$;

-- ── 2. Guard do Acesso Master: filiação extraída para função própria ───────────────
-- Extraída de iam._require_master_membership (456:66-103) — MESMO predicado (filiação viva no
-- UUID fixo do Acesso Master), sem nenhuma outra mudança de comportamento.
CREATE OR REPLACE FUNCTION iam.is_master_member(p_uid VARCHAR)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM iam.user_groups ug
     WHERE ug.user_id = p_uid
       AND ug.group_id = 'a0000000-0000-0000-0000-000000000001'::uuid
       AND ug.removed_at IS NULL
  );
$$;
COMMENT ON FUNCTION iam.is_master_member(VARCHAR) IS
  'Spec 026: filiação REAL e VIVA ao Acesso Master (a0000000-…-01), extraída de '
  '_require_master_membership (456) para ser reusada pelas funções de simulação. Mesmo predicado, '
  'sem mudança de comportamento — 456 passa a delegar aqui.';

CREATE OR REPLACE FUNCTION iam._require_master_membership(p_group_id UUID)
RETURNS VOID
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, iam, public
AS $$
DECLARE
  v_master_id CONSTANT UUID := 'a0000000-0000-0000-0000-000000000001';
  v_actor VARCHAR;
BEGIN
  IF p_group_id IS DISTINCT FROM v_master_id THEN
    RETURN;   -- guard só existe para o Acesso Master — nunca para is_system em geral
  END IF;

  IF iam._is_system_context() THEN
    RETURN;   -- mesmo bypass de sync_country_feature_default (279) — não quebra boot/cron
  END IF;

  v_actor := iam._actor();

  IF NOT iam.is_master_member(v_actor) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = format(
        '[iam] ator %s tem permission_management:write mas não é membro vivo do Acesso Master — só quem pertence ao Acesso Master pode alterá-lo (spec 021, bloco 2, guard de pertencimento)',
        v_actor
      );
  END IF;
END;
$$;
COMMENT ON FUNCTION iam._require_master_membership(UUID) IS
  'Spec 021, bloco 2 (20/09/2026): quando p_group_id é o Acesso Master, exige que o ator seja '
  'membro VIVO dele (iam.is_master_member, 458) — além da célula permission_management:write que '
  '_require_manager já checou. Não vale para nenhum outro grupo, nem para is_system em geral. '
  'Contexto de sistema passa direto.';

-- ── 3. Predicado "ativa" e grupos que decidem a request ─────────────────────────────
-- O ÚNICO lugar com o predicado de simulação ativa (data-model.md §Princípio). Devolve NULL
-- (nenhuma linha) quando não há simulação viva — nunca decide sobre linha aberta e vencida.
CREATE OR REPLACE FUNCTION iam.active_group_simulation(p_uid VARCHAR, p_tenant UUID)
RETURNS iam.group_simulations
LANGUAGE sql
STABLE
AS $$
  SELECT s.*
    FROM iam.group_simulations s
    JOIN iam.permission_groups g
      ON g.id = s.group_id
     AND g.tenant_id = p_tenant
     AND g.archived_at IS NULL
   WHERE s.tenant_id = p_tenant
     AND s.user_id = p_uid
     AND s.ended_at IS NULL
     AND s.expires_at > now()
     AND iam.is_master_member(p_uid)   -- filiação REAL, viva — quem já não é Master nunca simula
   LIMIT 1;
$$;
COMMENT ON FUNCTION iam.active_group_simulation(VARCHAR, UUID) IS
  'Spec 026: a simulação viva do ator, se houver (ended_at IS NULL AND expires_at > now(), grupo '
  'vivo do tenant, ator ainda membro real do Master). NULL sem simulação — nunca decide sobre '
  'linha aberta e vencida (a próxima writer a fecha como EXPIRED).';

-- Os grupos que DECIDEM esta request: a simulação SUBSTITUI os grupos reais (nunca soma).
CREATE OR REPLACE FUNCTION iam.acting_groups(p_uid VARCHAR, p_tenant UUID)
RETURNS SETOF UUID
LANGUAGE sql
STABLE
AS $$
  WITH sim AS MATERIALIZED (
    SELECT (iam.active_group_simulation(p_uid, p_tenant)).group_id AS group_id
  )
  SELECT sim.group_id FROM sim WHERE sim.group_id IS NOT NULL
  UNION ALL
  SELECT ug.group_id
    FROM iam.user_groups ug
   WHERE ug.user_id = p_uid
     AND ug.removed_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM sim WHERE sim.group_id IS NOT NULL);
$$;
COMMENT ON FUNCTION iam.acting_groups(VARCHAR, UUID) IS
  'Spec 026: COALESCE(grupo simulado, grupos reais vivos) — nunca união. effective_permissions/'
  'effective_countries (458) filtram por aqui em vez de iam.user_groups direto.';

-- ── 4. effective_permissions / effective_countries (276) — só a fonte de grupos muda ─
-- Texto idêntico à 276:23-49, trocando `FROM iam.user_groups ug … WHERE ug.user_id = p_user_id
-- AND ug.removed_at IS NULL` por `iam.acting_groups(p_user_id, p_tenant_id)`. TODOS os demais
-- filtros (status ACTIVE, tenant, archived_at, deprecated_at/revoked_at, DISTINCT, ORDER BY 1)
-- ficam iguais.
CREATE OR REPLACE FUNCTION iam.effective_permissions(p_user_id VARCHAR, p_tenant_id UUID)
RETURNS TEXT[]
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(ARRAY(
    SELECT DISTINCT p.resource || ':' || p.action
    FROM iam.acting_groups(p_user_id, p_tenant_id) ag
    JOIN users u
      ON u.firebase_uid = p_user_id
     AND u.status = 'ACTIVE'
    JOIN iam.permission_groups g
      ON g.id = ag
     AND g.tenant_id = p_tenant_id
     AND g.archived_at IS NULL
    JOIN iam.group_permissions gp
      ON gp.group_id = g.id
    JOIN iam.permissions p
      ON p.id = gp.permission_id
     AND p.deprecated_at IS NULL
    ORDER BY 1
  ), ARRAY[]::TEXT[]);
$$;
COMMENT ON FUNCTION iam.effective_permissions(VARCHAR, UUID) IS
  'União das células recurso:ação dos grupos que DECIDEM (iam.acting_groups, 458: simulação ou '
  'grupos VIVOS reais) do staff (ACTIVE, não-arquivado, não-deprecated), no tenant. Sem grupo → '
  '[]. Fonte única (D115); simulação (D407) troca só a fonte de grupos, não os demais filtros.';

CREATE OR REPLACE FUNCTION iam.effective_countries(p_user_id VARCHAR, p_tenant_id UUID)
RETURNS TEXT[]
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(ARRAY(
    SELECT DISTINCT gcs.country
    FROM iam.acting_groups(p_user_id, p_tenant_id) ag
    JOIN users u
      ON u.firebase_uid = p_user_id
     AND u.status = 'ACTIVE'
    JOIN iam.permission_groups g
      ON g.id = ag
     AND g.tenant_id = p_tenant_id
     AND g.archived_at IS NULL
    JOIN iam.group_country_scopes gcs
      ON gcs.group_id = g.id
     AND gcs.revoked_at IS NULL
    ORDER BY 1
  ), ARRAY[]::TEXT[]);
$$;
COMMENT ON FUNCTION iam.effective_countries(VARCHAR, UUID) IS
  'Países concedidos pelos grupos que DECIDEM (iam.acting_groups, 458). Sem grupo → []. É o que a '
  'policy RLS de país (411, via session_may_see_country) consulta — herda a simulação (D407).';

-- ── 5. Trilha: iam.permission_audit_log ganha simulation_id ────────────────────────
ALTER TABLE iam.permission_audit_log ADD COLUMN IF NOT EXISTS simulation_id UUID NULL;
COMMENT ON COLUMN iam.permission_audit_log.simulation_id IS
  'Spec 026: iam.group_simulations.id ativa no momento da decisão registrada, se houver. NULL '
  'fora de simulação (todo o histórico anterior à 458, e toda decisão fora de simulação).';

-- FK best-effort: a tabela é particionada (RANGE em created_at) e append-only (283); se o
-- Postgres recusar a FK num filho/mãe já existente, regista a mensagem e segue SEM FK — não
-- para a migration (nenhum caminho de escrita depende da FK existir).
DO $$
BEGIN
  ALTER TABLE iam.permission_audit_log
    ADD CONSTRAINT permission_audit_log_simulation_id_fkey
    FOREIGN KEY (simulation_id) REFERENCES iam.group_simulations(id);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE '[458] FK simulation_id -> iam.group_simulations(id) recusada: % (%) — seguindo sem FK', SQLERRM, SQLSTATE;
END
$$;

-- query_audit devolve SETOF do tipo da tabela → depende do rowtype (mudou); recriar como a 283
-- fez (DROP + CREATE, não OR REPLACE). Texto idêntico a 283:61-110, só acrescentando
-- a.simulation_id na lista explícita de colunas (nota técnica (c) do parecer, C1/lex-veredito).
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
           a.country,
           a.simulation_id
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

-- ── 6. Writers: start/end (molde 279/456) ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION iam.start_group_simulation(p_group_id UUID, p_ttl INTERVAL)
RETURNS iam.group_simulations
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, iam, public
AS $$
DECLARE
  v_master_id CONSTANT UUID := 'a0000000-0000-0000-0000-000000000001';
  v_actor  VARCHAR;
  v_tenant UUID;
  v_g      iam.permission_groups%ROWTYPE;
  v_open   iam.group_simulations%ROWTYPE;
  v_row    iam.group_simulations%ROWTYPE;
BEGIN
  v_actor := iam._actor();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = '[iam] sessão sem identidade — não é possível simular grupo';
  END IF;
  v_tenant := iam.current_tenant_id();

  IF NOT iam.is_master_member(v_actor) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = format('[iam] ator %s não é membro vivo do Acesso Master — só o Acesso Master simula grupo (spec 026)', v_actor);
  END IF;

  IF p_group_id = v_master_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = '[iam] grupo de sistema não é simulável';
  END IF;

  SELECT * INTO v_g FROM iam.permission_groups
   WHERE id = p_group_id AND tenant_id = v_tenant AND archived_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = '[iam] grupo inexistente, arquivado ou de outro tenant';
  END IF;

  -- Troca = fecha a aberta (se houver) + abre outra. EXPIRED se já tinha vencido, senão SUPERSEDED.
  SELECT * INTO v_open FROM iam.group_simulations
   WHERE tenant_id = v_tenant AND user_id = v_actor AND ended_at IS NULL;
  IF FOUND THEN
    UPDATE iam.group_simulations
       SET ended_at = now(),
           ended_reason = CASE WHEN v_open.expires_at <= now() THEN 'EXPIRED' ELSE 'SUPERSEDED' END
     WHERE id = v_open.id;
  END IF;

  INSERT INTO iam.group_simulations (tenant_id, user_id, group_id, expires_at)
  VALUES (v_tenant, v_actor, p_group_id, now() + p_ttl)
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;
COMMENT ON FUNCTION iam.start_group_simulation(UUID, INTERVAL) IS
  'Spec 026: abre simulação do grupo p_group_id para o ator (Acesso Master real, iam._actor()), '
  'por p_ttl. 42501 se não-Master; 23514 se o alvo é o próprio Acesso Master; P0002 se o grupo não '
  'existe, está arquivado ou é de outro tenant. Fecha a simulação aberta anterior do ator '
  '(EXPIRED se já vencida, senão SUPERSEDED) antes de abrir a nova.';

CREATE OR REPLACE FUNCTION iam.end_group_simulation()
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, iam, public
AS $$
DECLARE
  v_actor  VARCHAR;
  v_tenant UUID;
  v_open   iam.group_simulations%ROWTYPE;
BEGIN
  v_actor := iam._actor();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = '[iam] sessão sem identidade — não é possível encerrar simulação';
  END IF;
  v_tenant := iam.current_tenant_id();

  SELECT * INTO v_open FROM iam.group_simulations
   WHERE tenant_id = v_tenant AND user_id = v_actor AND ended_at IS NULL;
  IF NOT FOUND THEN
    RETURN FALSE;   -- idempotente: nada aberto para fechar
  END IF;

  UPDATE iam.group_simulations
     SET ended_at = now(),
         ended_reason = CASE WHEN v_open.expires_at <= now() THEN 'EXPIRED' ELSE 'USER' END
   WHERE id = v_open.id;

  RETURN TRUE;
END;
$$;
COMMENT ON FUNCTION iam.end_group_simulation() IS
  'Spec 026: fecha a simulação aberta do ator (EXPIRED se já vencida, senão USER). TRUE se '
  'havia uma aberta para fechar; FALSE se não havia (idempotente).';

-- ── Grants: EXECUTE só às roles do app; PUBLIC não (molde 279/456) ─────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    REVOKE ALL ON FUNCTION iam.is_master_member(varchar) FROM PUBLIC;
    REVOKE ALL ON FUNCTION iam.active_group_simulation(varchar,uuid) FROM PUBLIC;
    REVOKE ALL ON FUNCTION iam.acting_groups(varchar,uuid) FROM PUBLIC;
    REVOKE ALL ON FUNCTION iam.start_group_simulation(uuid,interval) FROM PUBLIC;
    REVOKE ALL ON FUNCTION iam.end_group_simulation() FROM PUBLIC;

    GRANT EXECUTE ON FUNCTION iam.is_master_member(varchar) TO app_runtime, app_system;
    GRANT EXECUTE ON FUNCTION iam.active_group_simulation(varchar,uuid) TO app_runtime, app_system;
    GRANT EXECUTE ON FUNCTION iam.acting_groups(varchar,uuid) TO app_runtime, app_system;
    GRANT EXECUTE ON FUNCTION iam.start_group_simulation(uuid,interval) TO app_runtime, app_system;
    GRANT EXECUTE ON FUNCTION iam.end_group_simulation() TO app_runtime, app_system;
  END IF;
END
$$;

COMMIT;
