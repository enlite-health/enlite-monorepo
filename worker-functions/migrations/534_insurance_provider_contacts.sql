-- 534 — E2: pessoa de contato da obra social (spec 058 Parte A, §2.1 E2; plan §2).
-- DADO PESSOAL: telefone, e-mail e número de documento ficam CIFRADOS (KMS, `*_encrypted`, molde `workers`/136); `document_type` em claro
-- (o tipo sozinho não identifica ninguém). Sem unicidade e sem índice de busca (ninguém pediu; se precisar, blind index em spec própria).
-- Formato do e-mail e vocabulário do documento são validados no zod; o CHECK de `document_type` é CÓPIA declarada de
-- `DOCUMENT_TYPES` (DocumentType.ts) e um teste de contrato compara os dois. O par tipo+número é por CHECK: ou os dois, ou nenhum.
-- Sem DELETE (`REVOKE DELETE`): "aposentar" grava `retired_at`. O `retire` manda o sentinela `'infinity'` e o trigger troca por
-- `now()` (R5); o CHECK `…_retired_at_finito` garante que o sentinela nunca sobrevive se o trigger faltar (R5′).
-- `enlite_mcp_ro` NÃO lê esta tabela (PII cifrada): REVOKE aqui + a tabela entra na lista do `scripts/create-mcp-ro-role.sql`.
-- Idempotente (2×). Rollback: migrations/pending/ROLLBACK_534_insurance_provider_contacts.sql.

CREATE TABLE IF NOT EXISTS insurance_provider_contacts (
  id                        UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_code             TEXT         NOT NULL REFERENCES insurance_providers(code),
  full_name                 TEXT         NOT NULL,
  role_title                TEXT         NOT NULL,
  phone_encrypted           TEXT         NOT NULL,
  email_encrypted           TEXT         NULL,
  document_type             TEXT         NULL,
  document_number_encrypted TEXT         NULL,
  retired_at                TIMESTAMPTZ  NULL,
  created_by                VARCHAR(128) NOT NULL,
  updated_by                VARCHAR(128) NOT NULL,
  created_at                TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT insurance_provider_contacts_full_name_not_blank CHECK (btrim(full_name) <> ''),
  CONSTRAINT insurance_provider_contacts_role_title_not_blank CHECK (btrim(role_title) <> ''),
  CONSTRAINT insurance_provider_contacts_document_type_check
    CHECK (document_type IS NULL OR document_type IN ('DNI', 'PASSPORT', 'CEDULA', 'LE_LC', 'CPF')),
  CONSTRAINT insurance_provider_contacts_document_pair_chk
    CHECK ((document_type IS NULL) = (document_number_encrypted IS NULL)),
  CONSTRAINT insurance_provider_contacts_retired_at_finito
    CHECK (retired_at IS NULL OR retired_at <> 'infinity')
);

CREATE INDEX IF NOT EXISTS idx_insurance_provider_contacts_provider
  ON insurance_provider_contacts (provider_code);

-- R5: o `retire` grava o sentinela 'infinity'; o banco troca por now().
CREATE OR REPLACE FUNCTION fn_058_a_contacts_retired_at()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.retired_at = 'infinity' THEN
    NEW.retired_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_058_a_contacts_retired_at ON insurance_provider_contacts;
CREATE TRIGGER trg_058_a_contacts_retired_at
  BEFORE INSERT OR UPDATE ON insurance_provider_contacts
  FOR EACH ROW EXECUTE FUNCTION fn_058_a_contacts_retired_at();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON insurance_provider_contacts TO app_runtime';
    EXECUTE 'REVOKE DELETE ON insurance_provider_contacts FROM app_runtime';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_system') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON insurance_provider_contacts TO app_system';
    EXECUTE 'REVOKE DELETE ON insurance_provider_contacts FROM app_system';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'enlite_mcp_ro') THEN
    EXECUTE 'REVOKE SELECT ON insurance_provider_contacts FROM enlite_mcp_ro';
  END IF;
END
$$;

COMMENT ON TABLE insurance_provider_contacts IS
  'Pessoa de contato da obra social (spec 058, E2). DADO PESSOAL: phone/email/document_number cifrados (KMS); nunca em log/erro; fora do enlite_mcp_ro. Sem DELETE: aposentar = retired_at.';
COMMENT ON COLUMN insurance_provider_contacts.document_type IS
  'Vocabulário DOCUMENT_TYPES (DocumentType.ts) — cópia declarada; teste de contrato compara com pg_get_constraintdef. Em claro: o tipo sozinho não identifica ninguém.';
