-- ROLLBACK_556_078_agente_principal.sql — par de rollback da migration 556 (spec 078, M2: o agente como pessoa no ABAC).
--
-- Mora em `migrations/pending/` (sem número): o runner só lê `migrations/` sem recursão. Só roda quando alguém aponta o caminho:
--   ./scripts/run-migration-prod.sh worker-functions/migrations/pending/ROLLBACK_556_078_agente_principal.sql
--
-- ⚠️ DESTRUTIVO e MANUAL: exige backup e o "vai" do Gabriel. Ordem INVERSA da 556.
--   · apaga a linha `agent:luz`, o grupo "Luz — espelho Recrutador" (com vínculos, países e células) e as colunas da trilha (perde actor_kind/gatilho_id/registro_versao);
--   · outro grupo de classe AGENT volta a INTERNAL; OUTRA linha com account_type='agent' faz o CHECK antigo FALHAR de propósito (remover à mão antes);
--   · `iam.query_audit` volta ao corpo da 458 (11 colunas) DEPOIS das colunas caírem.

DROP TRIGGER IF EXISTS veda_agente_fora_de_grupo_agent ON iam.user_groups;
DROP TRIGGER IF EXISTS veda_trocar_classe_agente ON iam.permission_groups;
DROP TRIGGER IF EXISTS veda_celula_a_agente ON iam.group_permissions;
DROP FUNCTION IF EXISTS iam.trg_veda_agente_fora_de_grupo_agent();
DROP FUNCTION IF EXISTS iam.trg_veda_trocar_classe_agente();
DROP FUNCTION IF EXISTS iam.trg_veda_celula_a_agente();
DROP FUNCTION IF EXISTS iam.celulas_vedadas_a_agente();

-- trilha: índice, CHECKs e colunas (as linhas do agente perdem a distinção)
DROP INDEX IF EXISTS iam.idx_pal_agente_user_created;
ALTER TABLE iam.permission_audit_log DROP CONSTRAINT IF EXISTS permission_audit_log_agente_versao_ck;
ALTER TABLE iam.permission_audit_log DROP CONSTRAINT IF EXISTS permission_audit_log_actor_kind_ck;
ALTER TABLE iam.permission_audit_log DROP COLUMN IF EXISTS registro_versao, DROP COLUMN IF EXISTS gatilho_id, DROP COLUMN IF EXISTS actor_kind;

-- query_audit: corpo da 458 (SELECT de 11 colunas = o tipo da tabela sem as 3 colunas)
CREATE OR REPLACE FUNCTION iam.query_audit(p_user_id character varying, p_resource character varying, p_since timestamp with time zone, p_until timestamp with time zone, p_limit integer)
 RETURNS SETOF iam.permission_audit_log
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'iam', 'public'
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

-- o agente e o grupo espelho
DELETE FROM iam.user_groups WHERE user_id = 'agent:luz';
DELETE FROM iam.permission_groups
 WHERE tenant_id = '00000000-0000-0000-0000-000000000001' AND name = 'Luz — espelho Recrutador';
DELETE FROM users WHERE firebase_uid = 'agent:luz';
-- outros grupos AGENT precisam voltar a INTERNAL ANTES do CHECK antigo
UPDATE iam.permission_groups SET actor_class = 'INTERNAL' WHERE actor_class = 'AGENT';
ALTER TABLE iam.permission_groups DROP CONSTRAINT IF EXISTS permission_groups_actor_class_ck;
ALTER TABLE iam.permission_groups ADD CONSTRAINT permission_groups_actor_class_ck
  CHECK (actor_class IN ('INTERNAL', 'EXTERNAL_THIRD_PARTY'));
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_account_type_check;
ALTER TABLE users ADD CONSTRAINT users_account_type_check CHECK (account_type IN ('staff', 'worker'));

-- ledger do runner (scripts/run-migrations-docker.js: schema_migrations.filename): para poder reaplicar a 556
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    DELETE FROM schema_migrations WHERE filename = '556_078_agente_principal.sql';
  END IF;
END
$$;
