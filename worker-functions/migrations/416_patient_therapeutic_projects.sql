-- 416 — `patient_therapeutic_projects`: o Projeto Terapêutico do paciente, VERSIONADO E IMUTÁVEL
-- (spec 017; D299; lex 08/09 C1–C10; `2026-08-12a#REQ-06` "o projeto terapêutico tem versões").
--
-- ── O modelo (decisão do Gabriel, 08/09) ─────────────────────────────────────
-- Cada linha é UMA VERSÃO `major.minor`. "Novo" cria `max(major)+1 . 0`; "Editar" a versão M.m
-- NUNCA a altera: cria `M . max(minor de M)+1`, copiando os campos e aplicando a edição
-- (`edited_from_version_id` guarda de onde veio — a árvore existe se um dia precisar ramificar).
-- A "em andamento" da ficha é a de `created_at` mais recente; a lista é por `created_at` desc.
-- UPDATE/DELETE são recusados por trigger — a ÚNICA escrita permitida depois do INSERT é a
-- anulação (lex C5, Ley 25.326 art. 16: retificar/suprimir em 5 dias hábeis; supressão física
-- vedada pelo inc. 5 enquanto a guarda da Ley 26.529 art. 18 estiver em aberto — OP-04).
--
-- ── Os campos (o que o documento de referência tem; Figma onde coincide) ─────
--   contracted_service_id  o serviço contratado que o operador ESCOLHE (Gabriel 4a). Sem cascade:
--                          a versão antiga continua apontando mesmo depois da baixa do serviço.
--   diagnoses              JSONB [{uri, code, title}] — snapshot do CID-11 escolhido no combobox
--                          (só CID, sem texto livre — Gabriel Q5). Diagnóstico = sensível-saúde.
--   clinical_context       "Síntesis clínica y contexto" (seção IV) — TEXTO CLÍNICO LIVRE, teto 4000
--                          no CHECK e no zod (lex C6; a dívida D216-3c nasceu de teto só no cliente).
--   general_objective      "Objetivo general" (seção V) — texto livre, teto 4000.
--   specific_objectives    JSONB [{id, label}] — snapshot do catálogo 415 (seção VI).
--   activities             JSONB [{id, label}] — snapshot do catálogo 415 (seção VII).
--   pathology_types        JSONB [{id, label}] — snapshot do catálogo 415 ("Tipo de patología").
--                          Sozinho já revela saúde mental: a tabela NÃO tem coluna segura para o
--                          MCP (lex C1) — REVOGADA por inteiro em create-mcp-ro-role.sql.
--   start_date/end_date    "Plazo de implementación" (seção X); end >= start.
--   created_by             uid do staff autor ("Proyecto elaborado por"), NOT NULL (lex C10).
--
-- ── `country NOT NULL` sem DEFAULT + RLS na MESMA migration (lex C2) ─────────
-- Molde 319 (trigger deriva de `patients.country`; NOT NULL aplicado depois do trigger) + policy
-- `follow_patient` no molde 413. O e2e `country-rls-policies` exige RLS em toda tabela com FK
-- para `patients` — esta entra sem allowlist.
--
-- ── Morre com o paciente (lex C4) ────────────────────────────────────────────
-- `ON DELETE CASCADE` + `CASCADE_CHILDREN` em PatientTestFixtureService (D248).
--
-- Rollback: DROP TRIGGER/FUNCTION (3) e DROP TABLE — nasce vazia nesta árvore.

CREATE TABLE IF NOT EXISTS patient_therapeutic_projects (
  id                      UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id              UUID         NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  major                   INT          NOT NULL,
  minor                   INT          NOT NULL,
  edited_from_version_id  UUID         NULL REFERENCES patient_therapeutic_projects(id),
  contracted_service_id   UUID         NOT NULL REFERENCES patient_contracted_services(id),

  diagnoses               JSONB        NOT NULL,
  clinical_context        TEXT         NOT NULL,
  general_objective       TEXT         NOT NULL,
  specific_objectives     JSONB        NOT NULL,
  activities              JSONB        NOT NULL,
  pathology_types         JSONB        NOT NULL,
  start_date              DATE         NOT NULL,
  end_date                DATE         NOT NULL,

  -- lex C5: a ÚNICA escrita permitida depois do INSERT. `annul_reason` é rótulo curto, nunca dado do titular.
  annulled_at             TIMESTAMPTZ  NULL,
  annulled_by             VARCHAR(128) NULL,
  annul_reason            TEXT         NULL,

  country                 TEXT         NULL,  -- NOT NULL aplicada no fim, depois do trigger (molde 319)
  created_by              VARCHAR(128) NOT NULL,
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT ptp_version_positiva CHECK (major >= 1 AND minor >= 0),
  CONSTRAINT ptp_version_unica UNIQUE (patient_id, major, minor),
  CONSTRAINT ptp_clinical_context_len CHECK (length(clinical_context) BETWEEN 1 AND 4000),
  CONSTRAINT ptp_general_objective_len CHECK (length(general_objective) BETWEEN 1 AND 4000),
  CONSTRAINT ptp_prazo_coerente CHECK (end_date >= start_date),
  CONSTRAINT ptp_diagnoses_lista CHECK (jsonb_typeof(diagnoses) = 'array' AND jsonb_array_length(diagnoses) >= 1),
  CONSTRAINT ptp_specific_objectives_lista CHECK (jsonb_typeof(specific_objectives) = 'array' AND jsonb_array_length(specific_objectives) >= 1),
  CONSTRAINT ptp_activities_lista CHECK (jsonb_typeof(activities) = 'array' AND jsonb_array_length(activities) >= 1),
  CONSTRAINT ptp_pathology_types_lista CHECK (jsonb_typeof(pathology_types) = 'array' AND jsonb_array_length(pathology_types) >= 1),
  CONSTRAINT ptp_annul_reason_len CHECK (annul_reason IS NULL OR length(annul_reason) <= 200),
  CONSTRAINT ptp_anulacao_coerente CHECK (
    (annulled_at IS NULL AND annulled_by IS NULL AND annul_reason IS NULL)
    OR (annulled_at IS NOT NULL AND annulled_by IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_patient_therapeutic_projects_patient
  ON patient_therapeutic_projects (patient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_patient_therapeutic_projects_country
  ON patient_therapeutic_projects (country);

-- País herdado do paciente (molde 319 / lex C-a.1).
CREATE OR REPLACE FUNCTION fn_patient_therapeutic_projects_country_from_patient()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.country IS NULL THEN
    SELECT p.country INTO NEW.country FROM patients p WHERE p.id = NEW.patient_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_patient_therapeutic_projects_country ON patient_therapeutic_projects;
CREATE TRIGGER trg_patient_therapeutic_projects_country
  BEFORE INSERT ON patient_therapeutic_projects
  FOR EACH ROW EXECUTE FUNCTION fn_patient_therapeutic_projects_country_from_patient();

ALTER TABLE patient_therapeutic_projects ALTER COLUMN country SET NOT NULL;
ALTER TABLE patient_therapeutic_projects DROP CONSTRAINT IF EXISTS ptp_country_check;
ALTER TABLE patient_therapeutic_projects
  ADD CONSTRAINT ptp_country_check CHECK (country IN ('AR', 'BR'));

-- O serviço contratado escolhido é do MESMO paciente (posse), conferido no INSERT.
CREATE OR REPLACE FUNCTION fn_patient_therapeutic_projects_service_do_paciente()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM patient_contracted_services s
     WHERE s.id = NEW.contracted_service_id AND s.patient_id = NEW.patient_id
  ) THEN
    RAISE EXCEPTION 'ptp_service_de_outro_paciente: contracted_service_id não pertence ao paciente'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_patient_therapeutic_projects_service ON patient_therapeutic_projects;
CREATE TRIGGER trg_patient_therapeutic_projects_service
  BEFORE INSERT ON patient_therapeutic_projects
  FOR EACH ROW EXECUTE FUNCTION fn_patient_therapeutic_projects_service_do_paciente();

-- Imutabilidade (lex C5): depois do INSERT, só as três colunas de anulação podem mudar — uma vez.
-- DELETE é recusado sempre (o purge do paciente entra por CASCADE de `patients`, que o trigger de
-- linha não vê como DELETE direto? Vê. Por isso o DELETE é permitido SÓ quando o paciente-pai já
-- não existe — é o que o CASCADE faz: a linha do pai some primeiro).
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

DROP TRIGGER IF EXISTS trg_patient_therapeutic_projects_imutavel ON patient_therapeutic_projects;
CREATE TRIGGER trg_patient_therapeutic_projects_imutavel
  BEFORE UPDATE OR DELETE ON patient_therapeutic_projects
  FOR EACH ROW EXECUTE FUNCTION fn_patient_therapeutic_projects_imutavel();

-- RLS de país: segue o paciente (molde 413 / lex C2).
ALTER TABLE patient_therapeutic_projects ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS patient_therapeutic_projects_follow_patient ON patient_therapeutic_projects;
CREATE POLICY patient_therapeutic_projects_follow_patient ON patient_therapeutic_projects FOR ALL USING (
  (
    NULLIF(current_setting('app.system_context', true), '') IS NOT NULL
    AND pg_has_role(current_user, 'app_system', 'MEMBER')
  )
  OR EXISTS (SELECT 1 FROM patients p WHERE p.id = patient_therapeutic_projects.patient_id)
);

COMMENT ON TABLE patient_therapeutic_projects IS
  'Projeto terapêutico do paciente, uma linha por VERSÃO major.minor, imutável (spec 017, D299). '
  'Novo = major+1.0; Editar = minor+1 (edited_from_version_id). UPDATE só para anular (lex C5). '
  'Satélite de patients: country por trigger, RLS follow_patient, CASCADE no purge. Dado tocado: '
  'sensível-saúde (clinical_context, general_objective, diagnoses, pathology_types). Sem coluna '
  'segura: REVOGADA por inteiro do enlite_mcp_ro (lex C1). Base legal: Ley 25.326 art. 8 (OP-18).';
COMMENT ON COLUMN patient_therapeutic_projects.clinical_context IS
  'Síntese clínica (texto clínico livre, teto 4000). NUNCA em log, erro, prompt ou GBrain. Sai da API só '
  'com patient_clinical:read cumulativa a patient_therapeutic_project:read (lex C7).';
