-- Migration 556: o agente como pessoa no ABAC (spec 078, fase M2, itens 30-36)
--
-- Data: 03/11/2026. Contrato: `contratos-M2/migration-556.md` (ebrain), ajustado pelas "Decisões do lote 0" do plano-M2.
-- Seções (a ordem importa; NENHUMA FK nova, e REVOKE só sobre FUNÇÃO nova):
--   1  users.account_type aceita 'agent'                       (M2.1.1)
--   2  classe de grupo AGENT + função de células vedadas + 3 triggers   (M2.1.3)
--   3  iam.permission_audit_log: actor_kind, gatilho_id, registro_versao (M2.1.5)
--   4  seed: linha `agent:luz` e grupo AGENT "Luz — espelho Recrutador" (VAZIO) (M2.1.7)
-- Idempotente (IF NOT EXISTS / DROP ... IF EXISTS / ON CONFLICT DO NOTHING). Sem BEGIN/COMMIT próprio (o runner envolve).
-- Sem texto clínico. A migration NÃO concede célula a grupo nenhum.
-- Rollback: `migrations/pending/ROLLBACK_556_078_agente_principal.sql` (manual, destrutivo, exige backup e o "vai" do Gabriel).

-- ── 1. users.account_type aceita `agent` ─────────────────────────────────────────
-- `agent` NÃO é staff (isStaffAccount segue false: fail-closed). A ponte `account_type_for_role` (414) e o COMMENT da 414 NÃO mudam.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_account_type_check;
ALTER TABLE users ADD CONSTRAINT users_account_type_check
  CHECK (account_type IN ('staff', 'worker', 'agent'));

-- ── 2. Classe de grupo `AGENT` (molde: 285_actor_class_external_third_party.sql) ───
-- 2a. a classe entra no CHECK existente (nome lido em 285: permission_groups_actor_class_ck)
ALTER TABLE iam.permission_groups DROP CONSTRAINT IF EXISTS permission_groups_actor_class_ck;
ALTER TABLE iam.permission_groups ADD CONSTRAINT permission_groups_actor_class_ck
  CHECK (actor_class IN ('INTERNAL', 'EXTERNAL_THIRD_PARTY', 'AGENT'));

-- 2b. as células que um grupo AGENT NUNCA recebe (cópia de leitura em TS: ActorClass.ts CELULAS_VEDADAS_A_AGENTE, com teste de paridade)
--     Células de lote/massa além de worker:export: LISTA (M2.0.4 não fechou lista aprovada pelo Gabriel).
CREATE OR REPLACE FUNCTION iam.celulas_vedadas_a_agente()
RETURNS TEXT[] LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$ SELECT ARRAY[
  'permission_management:read',   -- gestão de permissão (spec 078 item 36)
  'permission_management:write',  -- idem; protege também o anti-lockout (iam.is_last_manager, 410)
  'worker:export'                 -- lote: tira o cadastro do perímetro num arquivo (285)
] $$;
REVOKE ALL ON FUNCTION iam.celulas_vedadas_a_agente() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT EXECUTE ON FUNCTION iam.celulas_vedadas_a_agente() TO app_runtime, app_system;
  END IF;
END
$$;

-- T1. célula vedada entrando em grupo AGENT (molde trg_veda_celula_a_terceiro, 285)
CREATE OR REPLACE FUNCTION iam.trg_veda_celula_a_agente()
RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = pg_catalog, iam, public
AS $$
DECLARE v_classe TEXT; v_celula TEXT;
BEGIN
  SELECT g.actor_class INTO v_classe FROM iam.permission_groups g WHERE g.id = NEW.group_id;
  IF v_classe IS DISTINCT FROM 'AGENT' THEN RETURN NEW; END IF;
  SELECT p.resource || ':' || p.action INTO v_celula FROM iam.permissions p WHERE p.id = NEW.permission_id;
  IF v_celula = ANY (iam.celulas_vedadas_a_agente()) THEN
    RAISE EXCEPTION 'celula % nao pode ser concedida a grupo AGENT (078 item 36)', v_celula
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS veda_celula_a_agente ON iam.group_permissions;
CREATE TRIGGER veda_celula_a_agente BEFORE INSERT OR UPDATE ON iam.group_permissions
  FOR EACH ROW EXECUTE FUNCTION iam.trg_veda_celula_a_agente();

-- T2. a classe do grupo mudando (molde trg_veda_virar_externo, 285)
--     (a) virar AGENT com célula vedada já dentro -> erro
--     (b) entrar em AGENT ou sair de AGENT com membro vivo (qualquer tipo) -> erro (a classe de um grupo com gente não muda)
--     Transições que não envolvem AGENT (INTERNAL <-> EXTERNAL_THIRD_PARTY) seguem como a 285 as deixou.
CREATE OR REPLACE FUNCTION iam.trg_veda_trocar_classe_agente()
RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = pg_catalog, iam, public
AS $$
DECLARE v_celula TEXT;
BEGIN
  IF NEW.actor_class IS NOT DISTINCT FROM OLD.actor_class THEN RETURN NEW; END IF;
  IF NEW.actor_class <> 'AGENT' AND OLD.actor_class <> 'AGENT' THEN RETURN NEW; END IF;
  IF NEW.actor_class = 'AGENT' THEN
    SELECT p.resource || ':' || p.action INTO v_celula
      FROM iam.group_permissions gp JOIN iam.permissions p ON p.id = gp.permission_id
     WHERE gp.group_id = NEW.id AND p.resource || ':' || p.action = ANY (iam.celulas_vedadas_a_agente())
     LIMIT 1;
    IF v_celula IS NOT NULL THEN
      RAISE EXCEPTION 'grupo nao pode virar AGENT: ja tem a celula vedada % (078 item 36)', v_celula
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM iam.user_groups ug WHERE ug.group_id = NEW.id AND ug.removed_at IS NULL) THEN
    RAISE EXCEPTION 'grupo com membro vivo nao pode entrar nem sair da classe AGENT (078 item 36)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS veda_trocar_classe_agente ON iam.permission_groups;
CREATE TRIGGER veda_trocar_classe_agente BEFORE UPDATE ON iam.permission_groups
  FOR EACH ROW EXECUTE FUNCTION iam.trg_veda_trocar_classe_agente();

-- T3. agente só é membro de grupo AGENT, e grupo AGENT só tem agente como membro (as duas direções)
CREATE OR REPLACE FUNCTION iam.trg_veda_agente_fora_de_grupo_agent()
RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = pg_catalog, iam, public
AS $$
DECLARE v_tipo TEXT; v_classe TEXT;
BEGIN
  IF NEW.removed_at IS NOT NULL THEN RETURN NEW; END IF;
  SELECT u.account_type INTO v_tipo FROM users u WHERE u.firebase_uid = NEW.user_id;
  SELECT g.actor_class INTO v_classe FROM iam.permission_groups g WHERE g.id = NEW.group_id;
  IF v_tipo = 'agent' AND v_classe IS DISTINCT FROM 'AGENT' THEN
    RAISE EXCEPTION 'agente so pode ser membro de grupo AGENT (078 item 36)' USING ERRCODE = 'check_violation';
  END IF;
  IF v_classe = 'AGENT' AND v_tipo IS DISTINCT FROM 'agent' THEN
    RAISE EXCEPTION 'grupo AGENT so aceita agente como membro (078 item 36)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS veda_agente_fora_de_grupo_agent ON iam.user_groups;
CREATE TRIGGER veda_agente_fora_de_grupo_agent BEFORE INSERT OR UPDATE ON iam.user_groups
  FOR EACH ROW EXECUTE FUNCTION iam.trg_veda_agente_fora_de_grupo_agent();

-- ── 3. Trilha de auditoria distingue agente de pessoa (item 34) ──────────────────────
-- `actor_kind` mantém o vocabulário PT da 551 (`humano|agente|sistema`). DEFAULT 'humano' preserva os INSERTs antigos
-- (PgPermissionAuditRepository + as funções SQL 279/280/283/458) sem editar nenhum.
-- `gatilho_id` e `registro_versao` são SÓ identificadores (id da mensagem do prestador; 12 hex do sha do registro): NUNCA texto de mensagem.
ALTER TABLE iam.permission_audit_log
  ADD COLUMN IF NOT EXISTS actor_kind      text NOT NULL DEFAULT 'humano',
  ADD COLUMN IF NOT EXISTS gatilho_id      text,
  ADD COLUMN IF NOT EXISTS registro_versao text;

ALTER TABLE iam.permission_audit_log DROP CONSTRAINT IF EXISTS permission_audit_log_actor_kind_ck;
ALTER TABLE iam.permission_audit_log ADD CONSTRAINT permission_audit_log_actor_kind_ck
  CHECK (actor_kind IN ('humano', 'agente', 'sistema'));

-- agente sempre carrega a versão do registro que o governava (o responsável é DERIVADO do registro, não copiado)
ALTER TABLE iam.permission_audit_log DROP CONSTRAINT IF EXISTS permission_audit_log_agente_versao_ck;
ALTER TABLE iam.permission_audit_log ADD CONSTRAINT permission_audit_log_agente_versao_ck
  CHECK (actor_kind <> 'agente' OR registro_versao IS NOT NULL);

-- parcial: só enxerga linha de agente (o limitador por agente); custo em escrita humana ~0.
CREATE INDEX IF NOT EXISTS idx_pal_agente_user_created
  ON iam.permission_audit_log (user_id, created_at) WHERE actor_kind = 'agente';
