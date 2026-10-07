-- 501 — Remover Localización (spec 044, D4): trilha de auditoria SEM texto + célula ABAC `patient_address:delete`.
--
-- 1) `patient_address_audit_log` (schema canônico ADR-007, molde _TEMPLATE_audit_log.sql.example): 1 linha por
--    DELETE aceito, gravada na MESMA transação do DELETE. `changes` = { before: { address_id, address_type,
--    neighborhood }, after: null }, montado por lista POSITIVA de chaves no código. NÃO existe coluna de texto
--    de endereço (address_formatted/address_raw/complement/access_notes/lat/lng nunca entram): regra dura de
--    nunca logar PII e o objetivo do DELETE físico é minimização.
--    Append-only para o runtime (REVOKE UPDATE/DELETE/TRUNCATE, molde 269).
-- 2) Célula `patient_address:delete`: placeholder em `iam.permissions` (o sync do catálogo no boot sobrescreve a
--    descrição sem trocar o id; molde 497) para o grant não depender da ordem migration × boot. Grant aos grupos que
--    HOJE têm `patient_address:update` (+ Acesso Master pelo UUID fixo). Nenhum grupo é criado, movido ou reativado;
--    quem quiser outro conjunto muda só o INSERT ... SELECT abaixo.
-- Idempotente (IF NOT EXISTS / ON CONFLICT DO NOTHING).
-- Rollback: migrations/pending/ROLLBACK_501_patient_address_delete.sql.
CREATE TABLE IF NOT EXISTS patient_address_audit_log (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id       UUID         NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  event_type       VARCHAR(30)  NOT NULL
    CHECK (event_type IN ('CREATED','UPDATED','DELETED','STATUS_CHANGED','DRAFT_CHANGED')),
  field_name       VARCHAR(80)  NULL,
  changes          JSONB        NOT NULL DEFAULT '{}',
  actor_user_id    VARCHAR(128) NULL REFERENCES users(firebase_uid) ON DELETE SET NULL,
  actor_type       VARCHAR(20)  NOT NULL DEFAULT 'HUMAN'
    CHECK (actor_type IN ('HUMAN','SYSTEM','WEBHOOK','CLI')),
  actor_label      VARCHAR(80)  NULL,
  trace_id         TEXT         NULL,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE patient_address_audit_log IS
  'Append-only audit log da remoção de Localizaciones (patient_addresses), spec 044. '
  'Só DELETED é usado. SEM texto de endereço: changes.before leva apenas address_id, address_type e neighborhood.';
COMMENT ON COLUMN patient_address_audit_log.changes IS
  'DELETED: { before: { address_id, address_type, neighborhood }, after: null }. Lista positiva de chaves no código; '
  'nunca address_formatted/address_raw/complement/access_notes/lat/lng.';
COMMENT ON COLUMN patient_address_audit_log.actor_user_id IS
  'firebase_uid de quem removeu o endereço (FK users, SET NULL se o usuário for apagado).';

CREATE INDEX IF NOT EXISTS idx_patient_address_al_entity
  ON patient_address_audit_log(patient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_patient_address_al_actor_user
  ON patient_address_audit_log(actor_user_id, created_at DESC)
  WHERE actor_user_id IS NOT NULL;

-- Append-only para as roles do app (INSERT e SELECT ficam); manutenção excepcional roda como owner.
-- Guardado: em ambientes sem as roles da 269 (local/CI cru) o REVOKE seria erro.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON patient_address_audit_log FROM app_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_system') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON patient_address_audit_log FROM app_system;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'enlite_mcp_ro') THEN
    REVOKE ALL ON patient_address_audit_log FROM enlite_mcp_ro;
  END IF;
END
$$;

-- ── Célula patient_address:delete + grants ──────────────────────────────────────────────────────────
-- ROLLBACK: DELETE FROM iam.group_permissions WHERE permission_id IN
--   (SELECT id FROM iam.permissions WHERE resource = 'patient_address' AND action = 'delete');
DO $$
DECLARE
  v_master_id CONSTANT UUID := 'a0000000-0000-0000-0000-000000000001';
  v_n INT;
BEGIN
  IF to_regclass('iam.permissions') IS NOT NULL THEN
    INSERT INTO iam.permissions (resource, action, description, category, owner_service, deprecated_at)
    VALUES
      ('patient_address', 'delete',
       '[501 placeholder — sincronizado no boot] Remover uma Localización do paciente (definitivo; só sem vaga nem serviço apontando).',
       'Pacientes', 'worker-functions', NULL)
    ON CONFLICT (resource, action) DO NOTHING;
  END IF;

  IF to_regclass('iam.permission_groups') IS NOT NULL AND to_regclass('iam.group_permissions') IS NOT NULL THEN
    INSERT INTO iam.group_permissions (group_id, permission_id)
    SELECT gp.group_id, d.id
      FROM iam.group_permissions gp
      JOIN iam.permissions u ON u.id = gp.permission_id
      JOIN iam.permissions d ON d.resource = 'patient_address' AND d.action = 'delete' AND d.deprecated_at IS NULL
     WHERE u.resource = 'patient_address' AND u.action = 'update' AND u.deprecated_at IS NULL
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE '[501] patient_address:delete concedida a % grupo(s) que já tinham patient_address:update', v_n;

    INSERT INTO iam.group_permissions (group_id, permission_id)
    SELECT v_master_id, p.id
      FROM iam.permissions p
     WHERE p.resource = 'patient_address' AND p.action = 'delete' AND p.deprecated_at IS NULL
       AND EXISTS (SELECT 1 FROM iam.permission_groups g WHERE g.id = v_master_id)
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE '[501] grant ao Acesso Master: % célula(s) patient_address:delete', v_n;
  END IF;
END
$$;
