-- 417 — Respostas da Ana Joulie (gestão, 08/09/2026) ao PDF do projeto terapêutico (spec 017; D301):
--   (a) `patient_therapeutic_projects.modality` — modalidade do acompanhamento: presencial, on-line
--       ou híbrida ("vc pode usar para modalidade: presencial, on-line e hibrida").
--   (b) `patient_coverage_emergency_contacts` — os contatos de EMERGÊNCIA DA COBERTURA MÉDICA do
--       paciente ("pode ter varios contatos: profissional direto, ambulancia, central de atendimento
--       de emergencia"). O outro campo de emergência do PDF — familiar/pessoa responsável — já
--       existe (`patient_responsibles`). Vive na seção "cobertura" da ficha (container
--       `patient_coverage`, células já existentes), lido pela ficha e impresso no PDF.
--
-- ── (a) modality ─────────────────────────────────────────────────────────────
-- NULL nas versões anteriores a esta migration (imutáveis: não se retroalimenta); o zod EXIGE nas
-- versões novas. O trigger de imutabilidade enumera colunas: recriado com `modality` na lista.
ALTER TABLE patient_therapeutic_projects ADD COLUMN IF NOT EXISTS modality TEXT NULL;
ALTER TABLE patient_therapeutic_projects DROP CONSTRAINT IF EXISTS ptp_modality_check;
ALTER TABLE patient_therapeutic_projects
  ADD CONSTRAINT ptp_modality_check CHECK (modality IS NULL OR modality IN ('IN_PERSON', 'ONLINE', 'HYBRID'));
COMMENT ON COLUMN patient_therapeutic_projects.modality IS
  'Modalidade do acompanhamento (IN_PERSON | ONLINE | HYBRID) — Ana 08/09; NULL só em versão anterior à 417.';

CREATE OR REPLACE FUNCTION fn_patient_therapeutic_projects_imutavel()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM patients p WHERE p.id = OLD.patient_id) THEN
      RAISE EXCEPTION 'ptp_imutavel: versão do projeto terapêutico não se apaga (lex C5)'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
     OR NEW.major IS DISTINCT FROM OLD.major
     OR NEW.minor IS DISTINCT FROM OLD.minor
     OR NEW.edited_from_version_id IS DISTINCT FROM OLD.edited_from_version_id
     OR NEW.contracted_service_id IS DISTINCT FROM OLD.contracted_service_id
     OR NEW.modality IS DISTINCT FROM OLD.modality
     OR NEW.diagnoses IS DISTINCT FROM OLD.diagnoses
     OR NEW.clinical_context IS DISTINCT FROM OLD.clinical_context
     OR NEW.general_objective IS DISTINCT FROM OLD.general_objective
     OR NEW.specific_objectives IS DISTINCT FROM OLD.specific_objectives
     OR NEW.activities IS DISTINCT FROM OLD.activities
     OR NEW.pathology_types IS DISTINCT FROM OLD.pathology_types
     OR NEW.start_date IS DISTINCT FROM OLD.start_date
     OR NEW.end_date IS DISTINCT FROM OLD.end_date
     OR NEW.country IS DISTINCT FROM OLD.country
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'ptp_imutavel: versão do projeto terapêutico não se edita — crie a minor seguinte (lex C5)'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.annulled_at IS NOT NULL AND (
       NEW.annulled_at IS DISTINCT FROM OLD.annulled_at
    OR NEW.annulled_by IS DISTINCT FROM OLD.annulled_by
    OR NEW.annul_reason IS DISTINCT FROM OLD.annul_reason
  ) THEN
    RAISE EXCEPTION 'ptp_imutavel: anulação não se desfaz nem se reescreve' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── (b) patient_coverage_emergency_contacts ──────────────────────────────────
-- Satélite de `patients` no molde 416/319/413: `country` por trigger (NOT NULL depois do trigger),
-- RLS `follow_patient`, CASCADE no purge. `DIRECT_PROFESSIONAL` é pessoa física (telefone de
-- terceiro informado pelo paciente/família); os outros dois são institucionais. O telefone vai
-- CIFRADO via KMS (`phone_encrypted`), como o dos responsáveis (136) — o teto de 40 do texto claro
-- fica no zod, porque o CHECK só veria o ciphertext. Escrita só pela seção "cobertura"
-- (`replaceAll`, como os responsáveis). Sem coluna segura para o MCP: REVOGADA por inteiro em
-- create-mcp-ro-role.sql; fora da cópia prd→stg (SKIP_TABLES).
-- Rollback: DROP TRIGGER/FUNCTION e DROP TABLE — nasce vazia nesta árvore.
CREATE TABLE IF NOT EXISTS patient_coverage_emergency_contacts (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id  UUID         NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  kind        TEXT         NOT NULL,
  name        TEXT         NOT NULL,
  phone_encrypted TEXT     NOT NULL,  -- KMS (LGPD/Ley 25.326): nunca texto claro no banco
  sort_order  INT          NOT NULL DEFAULT 0,
  country     TEXT         NULL,  -- NOT NULL aplicada no fim, depois do trigger (molde 319)
  created_by  VARCHAR(128) NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT pcec_kind_check  CHECK (kind IN ('DIRECT_PROFESSIONAL', 'AMBULANCE', 'EMERGENCY_CENTER')),
  CONSTRAINT pcec_name_check  CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT pcec_phone_check CHECK (char_length(phone_encrypted) > 0)
);

CREATE INDEX IF NOT EXISTS idx_patient_coverage_emergency_contacts_patient
  ON patient_coverage_emergency_contacts (patient_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_patient_coverage_emergency_contacts_country
  ON patient_coverage_emergency_contacts (country);

-- lex C7 (08/09): esta tabela aceita UPDATE (ao contrário da 416), então o país é FORÇADO a partir do
-- pai em todo INSERT/UPDATE — nunca fica divergente do paciente, nem por escrita direta.
CREATE OR REPLACE FUNCTION fn_patient_coverage_emergency_contacts_country_from_patient()
RETURNS TRIGGER AS $$
BEGIN
  SELECT p.country INTO NEW.country FROM patients p WHERE p.id = NEW.patient_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_patient_coverage_emergency_contacts_country ON patient_coverage_emergency_contacts;
CREATE TRIGGER trg_patient_coverage_emergency_contacts_country
  BEFORE INSERT OR UPDATE ON patient_coverage_emergency_contacts
  FOR EACH ROW EXECUTE FUNCTION fn_patient_coverage_emergency_contacts_country_from_patient();

ALTER TABLE patient_coverage_emergency_contacts ALTER COLUMN country SET NOT NULL;
ALTER TABLE patient_coverage_emergency_contacts DROP CONSTRAINT IF EXISTS pcec_country_check;
ALTER TABLE patient_coverage_emergency_contacts
  ADD CONSTRAINT pcec_country_check CHECK (country IN ('AR', 'BR'));

-- RLS de país: segue o paciente (molde 413 / lex C2).
ALTER TABLE patient_coverage_emergency_contacts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS patient_coverage_emergency_contacts_follow_patient ON patient_coverage_emergency_contacts;
CREATE POLICY patient_coverage_emergency_contacts_follow_patient ON patient_coverage_emergency_contacts FOR ALL USING (
  (
    NULLIF(current_setting('app.system_context', true), '') IS NOT NULL
    AND pg_has_role(current_user, 'app_system', 'MEMBER')
  )
  OR EXISTS (SELECT 1 FROM patients p WHERE p.id = patient_coverage_emergency_contacts.patient_id)
);

COMMENT ON TABLE patient_coverage_emergency_contacts IS
  'Contatos de emergência da COBERTURA MÉDICA do paciente (profissional direto, ambulância, central) — '
  'Ana 08/09, spec 017 D301. Satélite de patients: country por trigger, RLS follow_patient, CASCADE no '
  'purge. Dado pessoal de terceiro (DIRECT_PROFESSIONAL): sem coluna segura, REVOGADA do enlite_mcp_ro; '
  'fora da cópia prd→stg. Escrita só pela seção cobertura (patient_coverage:write).';
