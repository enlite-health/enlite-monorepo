-- Migration 202: worker_profile_changes_audit
-- Audit log de mudanças de perfil aplicadas via fluxo propose/confirm da Luz.
-- Segue o padrão de worker_status_history (field_name / old / new / changed_by).
--
-- old/new de campos PII são REDIGIDOS (last-4 pra documento, domínio pro email,
-- ano pra data) — mesma lógica do McpAuditLogger. Nunca guardar PII em claro aqui:
-- a coluna de origem é criptografada via KMS, o audit não pode anular isso.

CREATE TABLE IF NOT EXISTS worker_profile_changes_audit (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id          UUID         NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  pending_change_id  UUID         NULL,
  field_name         VARCHAR(60)  NOT NULL,
  old_value_redacted TEXT         NULL,
  new_value_redacted TEXT         NULL,
  changed_by         VARCHAR(40)  NOT NULL DEFAULT 'luz',
  source             VARCHAR(40)  NOT NULL DEFAULT 'triage',
  conversation_ref   VARCHAR(120) NULL,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Consulta de histórico por worker (ordem cronológica).
CREATE INDEX IF NOT EXISTS idx_profile_changes_audit_worker
  ON worker_profile_changes_audit(worker_id, created_at DESC);

COMMENT ON TABLE worker_profile_changes_audit IS
  'Audit de updates de perfil pela Luz (propose/confirm). old/new redigidos pra PII. changed_by=luz, source=triage.';
