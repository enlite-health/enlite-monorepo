-- 429 — ligação VERSÃO→CONTATO do projeto terapêutico, SÓ IDS, SEM gatilho automático
-- (spec 018, PR-7, US-15/16; `checklists/lex-pr7.md` C1/C10/C11 TRAVA; ADR-4; D328/SUP-25 rejeitou
-- a versão automática — a única automação é "editar aumenta a minor").
--
-- ── O que esta migration NÃO faz (D328) ──────────────────────────────────────
-- Não existe coluna `auto_reason`, nem trigger que crie versão quando um contato é editado,
-- desativado, ou quando plano/afiliado muda. `fn_patient_therapeutic_projects_imutavel` (416)
-- continua exatamente como está — sem lista nova para recriar. A ÚNICA forma de nova versão
-- continua sendo `POST /patients/:id/therapeutic-projects` (mode:'new'|'edit').
--
-- ── Só ids (lex #7) ───────────────────────────────────────────────────────────
-- Nunca nome/telefone/e-mail do contato. A leitura resolve o nome no momento da consulta, pela
-- célula de origem (application/therapeuticProjectAccess.ts) — fora do escopo desta migration.
--
-- ── `country` pelas 3 etapas do molde (lex C1, TRAVA) ────────────────────────
-- (1) trigger BEFORE INSERT copia `patients.country`; (2) `ALTER COLUMN country SET NOT NULL`;
-- (3) `CHECK (country IN ('AR','BR'))`. Ordem obrigatória: trigger primeiro (preenche as linhas
-- já existentes antes do NOT NULL — aqui a tabela nasce vazia, mas a ordem é a mesma do molde
-- 416/422 para não divergir).
--
-- ── Retenção (adendo OP-18, PR-7, `checklists/lex-pr7.md`) ───────────────────
-- FK sem CASCADE de contato (NO ACTION, default): apagar a linha do contato referenciado por
-- QUALQUER versão (mesmo anulada, mesmo histórica) é recusado (23503) — só a purga do paciente
-- (CASCADE via `patient_therapeutic_projects` → `patients`) apaga esta linha. Supressão pedida
-- pelo próprio contato = anonimização no lugar (mantém o id), fora desta migration (task 7.10,
-- trava a promoção a PRD, não a stage).
--
-- ── Imutável (mesma régua de 416/417) ────────────────────────────────────────
-- INSERT só dentro da transação que cria a versão (a versão tem de existir e ser do mesmo
-- paciente); UPDATE sempre recusado (55000); DELETE só quando o paciente-pai já não existe
-- (a mesma regra de `fn_patient_therapeutic_projects_imutavel`, 416:149-183).
--
-- Rollback: DROP TRIGGER/FUNCTION (2) e DROP TABLE — nasce vazia nesta árvore; DROP das UNIQUEs
-- compostas adicionadas às tabelas de contato (`pcec_id_patient_uq`; as outras três já existem:
-- `pr_id_patient_uq` 423, `pxc_id_patient_uq` 422, `pp_id_patient_uq` 427).

ALTER TABLE patient_coverage_emergency_contacts DROP CONSTRAINT IF EXISTS pcec_id_patient_uq;
ALTER TABLE patient_coverage_emergency_contacts ADD CONSTRAINT pcec_id_patient_uq UNIQUE (id, patient_id);

CREATE TABLE IF NOT EXISTS patient_therapeutic_project_contacts (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id            UUID         NOT NULL REFERENCES patient_therapeutic_projects(id) ON DELETE CASCADE,
  patient_id            UUID         NOT NULL,
  contact_kind          TEXT         NOT NULL CHECK (contact_kind IN ('RESPONSIBLE', 'EXTERNAL', 'COVERAGE', 'CARE_TEAM')),
  responsible_id        UUID         NULL,
  external_contact_id   UUID         NULL,
  coverage_contact_id   UUID         NULL,
  professional_id       UUID         NULL,
  sort_order            INT          NOT NULL DEFAULT 0,
  country               TEXT         NULL,  -- etapa 1: trigger abaixo preenche; etapa 2: NOT NULL; etapa 3: CHECK (lex C1)
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT ptpc_one_ref CHECK (num_nonnulls(responsible_id, external_contact_id, coverage_contact_id, professional_id) = 1),
  CONSTRAINT ptpc_kind_ref CHECK (
       (contact_kind = 'RESPONSIBLE' AND responsible_id IS NOT NULL)
    OR (contact_kind = 'EXTERNAL'    AND external_contact_id IS NOT NULL)
    OR (contact_kind = 'COVERAGE'    AND coverage_contact_id IS NOT NULL)
    OR (contact_kind = 'CARE_TEAM'   AND professional_id IS NOT NULL)
  ),
  -- NO ACTION (default): recusa DELETE direto do contato referenciado; a CASCADE da versão/paciente passa.
  CONSTRAINT ptpc_resp_fk FOREIGN KEY (responsible_id, patient_id)      REFERENCES patient_responsibles(id, patient_id),
  CONSTRAINT ptpc_ext_fk  FOREIGN KEY (external_contact_id, patient_id) REFERENCES patient_external_contacts(id, patient_id),
  CONSTRAINT ptpc_cov_fk  FOREIGN KEY (coverage_contact_id, patient_id) REFERENCES patient_coverage_emergency_contacts(id, patient_id),
  CONSTRAINT ptpc_pro_fk  FOREIGN KEY (professional_id, patient_id)     REFERENCES patient_professionals(id, patient_id)
);

CREATE INDEX IF NOT EXISTS idx_patient_therapeutic_project_contacts_version
  ON patient_therapeutic_project_contacts (version_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_patient_therapeutic_project_contacts_patient
  ON patient_therapeutic_project_contacts (patient_id);
CREATE INDEX IF NOT EXISTS idx_patient_therapeutic_project_contacts_country
  ON patient_therapeutic_project_contacts (country);
-- Evita duplicar o MESMO contato na MESMA versão (idempotência do INSERT em lote).
CREATE UNIQUE INDEX IF NOT EXISTS uq_ptpc_version_responsible ON patient_therapeutic_project_contacts (version_id, responsible_id) WHERE responsible_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ptpc_version_external    ON patient_therapeutic_project_contacts (version_id, external_contact_id) WHERE external_contact_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ptpc_version_coverage    ON patient_therapeutic_project_contacts (version_id, coverage_contact_id) WHERE coverage_contact_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ptpc_version_professional ON patient_therapeutic_project_contacts (version_id, professional_id) WHERE professional_id IS NOT NULL;

-- Etapa 1 (lex C1): país herdado do paciente, mesmo molde de 416/422.
CREATE OR REPLACE FUNCTION fn_patient_therapeutic_project_contacts_country_from_patient()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.country IS NULL THEN
    SELECT p.country INTO NEW.country FROM patients p WHERE p.id = NEW.patient_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_patient_therapeutic_project_contacts_country ON patient_therapeutic_project_contacts;
CREATE TRIGGER trg_patient_therapeutic_project_contacts_country
  BEFORE INSERT ON patient_therapeutic_project_contacts
  FOR EACH ROW EXECUTE FUNCTION fn_patient_therapeutic_project_contacts_country_from_patient();

-- Etapa 2 (lex C1): NOT NULL só depois do trigger acima existir (a tabela nasce vazia nesta árvore).
ALTER TABLE patient_therapeutic_project_contacts ALTER COLUMN country SET NOT NULL;

-- Etapa 3 (lex C1): CHECK do país.
ALTER TABLE patient_therapeutic_project_contacts DROP CONSTRAINT IF EXISTS ptpc_country_check;
ALTER TABLE patient_therapeutic_project_contacts
  ADD CONSTRAINT ptpc_country_check CHECK (country IN ('AR', 'BR'));

-- A versão referenciada existe, é do MESMO paciente e foi criada NESTA transação (SUP-26: a
-- ligação só nasce junto com a versão — nunca "adicionar contato depois" numa versão antiga,
-- que seria reescrever histórico). O contato referenciado tem de estar ATIVO no momento do INSERT
-- (edição/baixa posterior NÃO reabre esta checagem — D328/SUP-25: sem gatilho automático).
CREATE OR REPLACE FUNCTION fn_patient_therapeutic_project_contacts_imutavel()
RETURNS TRIGGER AS $$
DECLARE
  v_created_at TIMESTAMPTZ;
  v_patient_id UUID;
  v_active BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM patients p WHERE p.id = OLD.patient_id) THEN
      RAISE EXCEPTION 'ptpc_imutavel: ligação versão-contato não se apaga isoladamente (lex #7, adendo OP-18)'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'ptpc_imutavel: ligação versão-contato não se edita (lex #7)'
      USING ERRCODE = '55000';
  END IF;

  -- TG_OP = 'INSERT'
  SELECT created_at, patient_id INTO v_created_at, v_patient_id
    FROM patient_therapeutic_projects WHERE id = NEW.version_id;
  IF v_created_at IS NULL THEN
    RAISE EXCEPTION 'ptpc_versao_inexistente: version_id não existe' USING ERRCODE = '23503';
  END IF;
  IF v_patient_id IS DISTINCT FROM NEW.patient_id THEN
    RAISE EXCEPTION 'ptpc_versao_de_outro_paciente: version_id não pertence a patient_id' USING ERRCODE = '23503';
  END IF;
  IF v_created_at < (NOW() - INTERVAL '5 minutes') THEN
    RAISE EXCEPTION 'ptpc_fora_da_transacao: ligação só se insere na transação que cria a versão (SUP-26)'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.contact_kind = 'RESPONSIBLE' THEN
    SELECT active INTO v_active FROM patient_responsibles WHERE id = NEW.responsible_id;
  ELSIF NEW.contact_kind = 'EXTERNAL' THEN
    SELECT active INTO v_active FROM patient_external_contacts WHERE id = NEW.external_contact_id;
  ELSIF NEW.contact_kind = 'COVERAGE' THEN
    SELECT active INTO v_active FROM patient_coverage_emergency_contacts WHERE id = NEW.coverage_contact_id;
  ELSE
    SELECT active INTO v_active FROM patient_professionals WHERE id = NEW.professional_id;
  END IF;
  IF v_active IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'ptp_contact_inactive: contato inativo ou de outro paciente não pode ser referenciado'
      USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_patient_therapeutic_project_contacts_imutavel ON patient_therapeutic_project_contacts;
CREATE TRIGGER trg_patient_therapeutic_project_contacts_imutavel
  BEFORE INSERT OR UPDATE OR DELETE ON patient_therapeutic_project_contacts
  FOR EACH ROW EXECUTE FUNCTION fn_patient_therapeutic_project_contacts_imutavel();

-- RLS de país: segue o paciente (molde 413/416).
ALTER TABLE patient_therapeutic_project_contacts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS patient_therapeutic_project_contacts_follow_patient ON patient_therapeutic_project_contacts;
CREATE POLICY patient_therapeutic_project_contacts_follow_patient ON patient_therapeutic_project_contacts FOR ALL USING (
  (
    NULLIF(current_setting('app.system_context', true), '') IS NOT NULL
    AND pg_has_role(current_user, 'app_system', 'MEMBER')
  )
  OR EXISTS (SELECT 1 FROM patients p WHERE p.id = patient_therapeutic_project_contacts.patient_id)
);

-- GRANT explícito (a stage roda como app_runtime; sem ALTER DEFAULT PRIVILEGES — molde 419/422).
GRANT SELECT, INSERT, UPDATE, DELETE ON patient_therapeutic_project_contacts TO app_runtime, app_system;

-- REVOKE do enlite_mcp_ro: NÃO aqui (a role não é criada por migration) — em
-- `scripts/create-mcp-ro-role.sql`, MESMO commit (prova: grep patient_therapeutic_project_contacts
-- nesse arquivo). A tabela não tem coluna segura (nome/telefone/CID via a versão) e fica fora do
-- MCP por inteiro, como as outras três desta família (416, 417, 422, 427).

COMMENT ON TABLE patient_therapeutic_project_contacts IS
  'Ligação versão do projeto terapêutico → contato (spec 018, PR-7, US-15/16). Só ids — nunca nome/telefone. '
  'Sem gatilho automático (D328/SUP-25): editar/desativar o contato ou trocar plano/afiliado NÃO cria versão '
  'nova, e esta ligação não muda. Autoria = a da versão (created_by de patient_therapeutic_projects); a '
  'ligação não tem created_by próprio (lex C6). Imutável: INSERT só na transação que cria a versão, UPDATE '
  'sempre recusado, DELETE só via CASCADE da purga do paciente (retenção do adendo OP-18).';
COMMENT ON COLUMN patient_therapeutic_project_contacts.country IS
  'Herdado de patients.country por trigger (etapa 1/3, lex C1). NOT NULL (etapa 2/3) + CHECK AR/BR (etapa 3/3).';
