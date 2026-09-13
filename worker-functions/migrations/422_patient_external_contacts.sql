-- 422 — `patient_external_contacts` (spec 018, PR-2, US-12, `lex` #4).
--
-- Contato de terceiro SEM vínculo familiar (professor, diretor/funcionário de escola, vizinho,
-- empregador, gestor de caso da obra social, referente comunitário) na "rede de apoio" do
-- paciente. NÃO é responsável (já existe em `patient_responsibles`) nem contato de emergência da
-- cobertura médica (`patient_coverage_emergency_contacts`, migration 417). SEM categoria de
-- saúde no enum de `relation` (condição do lex), SEM documento (D-A #6), SEM texto livre (sem
-- `notes`). Troca de contato = desativar + criar (REGRA-08, D94) — nunca DELETE pela aplicação.
--
-- Molde = 417_therapeutic_modality_and_coverage_emergency_contacts.sql:103-158 + regras do
-- data-model.md §Regras de molde: country por trigger, RLS follow_patient, GRANT explícito,
-- REVOKE do enlite_mcp_ro, filha direta de patients (CASCADE_CHILDREN), fora de SKIP_TABLES
-- (ebrain — reportado à parte, não aplicado aqui), telefone cifrado por KMS.
--
-- `pxc_id_patient_uq UNIQUE (id, patient_id)` é o alvo da FK composta da marca de emergência (423).
--
-- Rollback: DROP TRIGGER/FUNCTION/POLICY e DROP TABLE — nasce vazia nesta árvore.
CREATE TABLE IF NOT EXISTS patient_external_contacts (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id       UUID         NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  relation         TEXT         NOT NULL,
  name             TEXT         NOT NULL,                  -- em claro (molde 417: name em claro, telefone cifrado)
  phone_encrypted  TEXT         NULL,                      -- KMS; sem telefone não pode ser marcado de emergência (D-A #3)
  sort_order       INT          NOT NULL DEFAULT 0,
  active           BOOLEAN      NOT NULL DEFAULT true,
  deactivated_at   TIMESTAMPTZ  NULL,
  deactivated_by   VARCHAR(128) NULL,
  country          TEXT         NULL,                      -- NOT NULL depois do trigger
  created_by       VARCHAR(128) NOT NULL,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT pxc_relation_check CHECK (relation IN ('TEACHER','SCHOOL_DIRECTOR','SCHOOL_STAFF','NEIGHBOR','EMPLOYER',
                                                    'INSURANCE_CASE_MANAGER','COMMUNITY_REFERENT','OTHER')),   -- SUP-15, SEM saúde
  CONSTRAINT pxc_name_check CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT pxc_active_coerente CHECK ((active AND deactivated_at IS NULL) OR (NOT active AND deactivated_at IS NOT NULL)),
  CONSTRAINT pxc_id_patient_uq UNIQUE (id, patient_id)      -- alvo da FK composta da marca (423)
);

CREATE INDEX IF NOT EXISTS idx_patient_external_contacts_patient_active
  ON patient_external_contacts (patient_id, sort_order) WHERE active;
CREATE INDEX IF NOT EXISTS idx_patient_external_contacts_country
  ON patient_external_contacts (country);

-- país FORÇADO a partir do pai em todo INSERT/UPDATE (mesmo padrão do lex C7 na 417): nunca
-- divergente do paciente, nem por escrita direta.
CREATE OR REPLACE FUNCTION fn_patient_external_contacts_country_from_patient()
RETURNS TRIGGER AS $$
BEGIN
  SELECT p.country INTO NEW.country FROM patients p WHERE p.id = NEW.patient_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_patient_external_contacts_country ON patient_external_contacts;
CREATE TRIGGER trg_patient_external_contacts_country
  BEFORE INSERT OR UPDATE ON patient_external_contacts
  FOR EACH ROW EXECUTE FUNCTION fn_patient_external_contacts_country_from_patient();

ALTER TABLE patient_external_contacts ALTER COLUMN country SET NOT NULL;
ALTER TABLE patient_external_contacts DROP CONSTRAINT IF EXISTS pxc_country_check;
ALTER TABLE patient_external_contacts
  ADD CONSTRAINT pxc_country_check CHECK (country IN ('AR', 'BR'));

-- RLS de país: segue o paciente (molde 413 / lex C2).
ALTER TABLE patient_external_contacts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS patient_external_contacts_follow_patient ON patient_external_contacts;
CREATE POLICY patient_external_contacts_follow_patient ON patient_external_contacts FOR ALL USING (
  (
    NULLIF(current_setting('app.system_context', true), '') IS NOT NULL
    AND pg_has_role(current_user, 'app_system', 'MEMBER')
  )
  OR EXISTS (SELECT 1 FROM patients p WHERE p.id = patient_external_contacts.patient_id)
);

-- GRANT explícito (lex #4; sem ALTER DEFAULT PRIVILEGES — molde de sintaxe 419_…sql:24-27).
GRANT SELECT, INSERT, UPDATE, DELETE ON patient_external_contacts TO app_runtime, app_system;

-- REVOKE do papel read-only do MCP: nome em claro + telefone de terceiro sem coluna segura.
REVOKE ALL ON patient_external_contacts FROM enlite_mcp_ro;

COMMENT ON TABLE patient_external_contacts IS
  'Contato de terceiro SEM vínculo familiar na rede de apoio do paciente (professor, escola, '
  'vizinho, empregador, gestor de caso, referente comunitário) — spec 018 PR-2, lex #4. Satélite '
  'de patients: country por trigger, RLS follow_patient, CASCADE no purge. SEM categoria de '
  'saúde no enum de relation, SEM documento, SEM texto livre. Telefone cifrado por KMS. Sem '
  'coluna segura para o MCP: REVOGADA por inteiro. Fora da cópia prd→stg (SKIP_TABLES no ebrain — '
  'ver linha reportada, não aplicada nesta migration). Troca = desativar + criar, nunca DELETE.';
