-- 423 — marca de emergência (spec 018, PR-2, US-8, D-A, SUP-39).
--
-- Aponta o contato de emergência do PACIENTE (distinto do contato de emergência da COBERTURA
-- MÉDICA, migration 417) para UMA linha já existente em `patient_responsibles` OU em
-- `patient_external_contacts` — nunca as duas (D-A #1, `num_nonnulls <= 1`). Não cria titular
-- nem categoria de dado nova: só referencia dado que já é coletado.
--
-- Validade da marca (D-A #3/#4, SUP-40):
--   1. BEFORE UPDATE OF emergency_* ON patients: o contato referenciado tem de estar ATIVO e ter
--      phone_encrypted preenchido, senão 23514 (não dá pra marcar alguém sem telefone ou já
--      desativado).
--   2. Nas tabelas-filhas, AFTER UPDATE OF active → false: se a linha desativada era a marcada,
--      limpa emergency_* do paciente na MESMA transação (D-A #4) — "no definido", não erro.
--   3. Nas tabelas-filhas, BEFORE UPDATE OF phone_encrypted → NULL: se a linha está marcada,
--      bloqueia com 23514 (SUP-40) — não dá pra apagar o telefone de quem está marcado sem
--      desmarcar antes.
--
-- Rollback: DROP TRIGGER/FUNCTION, DROP CONSTRAINT, DROP COLUMN emergency_* — nenhuma linha
-- pré-existente é afetada (colunas nascem NULL).

-- alvo da FK composta (mesmo padrão da pxc_id_patient_uq em 422).
ALTER TABLE patient_responsibles ADD CONSTRAINT pr_id_patient_uq UNIQUE (id, patient_id);

ALTER TABLE patients ADD COLUMN IF NOT EXISTS emergency_responsible_id       UUID NULL;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS emergency_external_contact_id  UUID NULL;

ALTER TABLE patients DROP CONSTRAINT IF EXISTS patients_emergency_one;
ALTER TABLE patients ADD CONSTRAINT patients_emergency_one
  CHECK (num_nonnulls(emergency_responsible_id, emergency_external_contact_id) <= 1);

ALTER TABLE patients DROP CONSTRAINT IF EXISTS patients_emergency_resp_fk;
ALTER TABLE patients ADD CONSTRAINT patients_emergency_resp_fk
  FOREIGN KEY (emergency_responsible_id, id) REFERENCES patient_responsibles(id, patient_id);          -- mesmo paciente

ALTER TABLE patients DROP CONSTRAINT IF EXISTS patients_emergency_ext_fk;
ALTER TABLE patients ADD CONSTRAINT patients_emergency_ext_fk
  FOREIGN KEY (emergency_external_contact_id, id) REFERENCES patient_external_contacts(id, patient_id);

COMMENT ON COLUMN patients.emergency_responsible_id IS
  'Marca de emergência apontando para patient_responsibles.id (mesmo paciente). No máximo 1 '
  'marca contando as duas colunas (patients_emergency_one). NULL = não definido.';
COMMENT ON COLUMN patients.emergency_external_contact_id IS
  'Marca de emergência apontando para patient_external_contacts.id (mesmo paciente). No máximo 1 '
  'marca contando as duas colunas (patients_emergency_one). NULL = não definido.';

-- ── 1. validade da marca no momento em que ela é ESCRITA ────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_patients_emergency_mark_valida()
RETURNS TRIGGER AS $$
DECLARE
  v_active BOOLEAN;
  v_phone  TEXT;
BEGIN
  IF NEW.emergency_responsible_id IS NOT NULL
     AND (NEW.emergency_responsible_id IS DISTINCT FROM OLD.emergency_responsible_id) THEN
    SELECT active, phone_encrypted INTO v_active, v_phone
      FROM patient_responsibles WHERE id = NEW.emergency_responsible_id;
    IF v_active IS NOT TRUE OR v_phone IS NULL THEN
      RAISE EXCEPTION 'patients_emergency_mark_invalida: responsável inativo ou sem telefone não pode ser marca de emergência'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.emergency_external_contact_id IS NOT NULL
     AND (NEW.emergency_external_contact_id IS DISTINCT FROM OLD.emergency_external_contact_id) THEN
    SELECT active, phone_encrypted INTO v_active, v_phone
      FROM patient_external_contacts WHERE id = NEW.emergency_external_contact_id;
    IF v_active IS NOT TRUE OR v_phone IS NULL THEN
      RAISE EXCEPTION 'patients_emergency_mark_invalida: contato externo inativo ou sem telefone não pode ser marca de emergência'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_patients_emergency_mark_valida ON patients;
CREATE TRIGGER trg_patients_emergency_mark_valida
  BEFORE UPDATE OF emergency_responsible_id, emergency_external_contact_id ON patients
  FOR EACH ROW EXECUTE FUNCTION fn_patients_emergency_mark_valida();

-- ── 2. desativar quem está marcado limpa a marca (mesma transação, D-A #4) ──────────────────
CREATE OR REPLACE FUNCTION fn_patient_responsibles_desativa_limpa_marca()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.active AND NOT NEW.active THEN
    UPDATE patients SET emergency_responsible_id = NULL
     WHERE id = NEW.patient_id AND emergency_responsible_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_patient_responsibles_desativa_limpa_marca ON patient_responsibles;
CREATE TRIGGER trg_patient_responsibles_desativa_limpa_marca
  AFTER UPDATE OF active ON patient_responsibles
  FOR EACH ROW EXECUTE FUNCTION fn_patient_responsibles_desativa_limpa_marca();

CREATE OR REPLACE FUNCTION fn_patient_external_contacts_desativa_limpa_marca()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.active AND NOT NEW.active THEN
    UPDATE patients SET emergency_external_contact_id = NULL
     WHERE id = NEW.patient_id AND emergency_external_contact_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_patient_external_contacts_desativa_limpa_marca ON patient_external_contacts;
CREATE TRIGGER trg_patient_external_contacts_desativa_limpa_marca
  AFTER UPDATE OF active ON patient_external_contacts
  FOR EACH ROW EXECUTE FUNCTION fn_patient_external_contacts_desativa_limpa_marca();

-- ── 3. apagar o telefone de quem está marcado é bloqueado (SUP-40) ──────────────────────────
CREATE OR REPLACE FUNCTION fn_patient_responsibles_bloqueia_apaga_telefone_marcado()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.phone_encrypted IS NOT NULL AND NEW.phone_encrypted IS NULL
     AND EXISTS (SELECT 1 FROM patients p WHERE p.emergency_responsible_id = NEW.id) THEN
    RAISE EXCEPTION 'patient_responsibles_telefone_marcado: desmarque a emergência antes de apagar o telefone'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_patient_responsibles_bloqueia_apaga_telefone_marcado ON patient_responsibles;
CREATE TRIGGER trg_patient_responsibles_bloqueia_apaga_telefone_marcado
  BEFORE UPDATE OF phone_encrypted ON patient_responsibles
  FOR EACH ROW EXECUTE FUNCTION fn_patient_responsibles_bloqueia_apaga_telefone_marcado();

CREATE OR REPLACE FUNCTION fn_patient_external_contacts_bloqueia_apaga_telefone_marcado()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.phone_encrypted IS NOT NULL AND NEW.phone_encrypted IS NULL
     AND EXISTS (SELECT 1 FROM patients p WHERE p.emergency_external_contact_id = NEW.id) THEN
    RAISE EXCEPTION 'patient_external_contacts_telefone_marcado: desmarque a emergência antes de apagar o telefone'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_patient_external_contacts_bloqueia_apaga_telefone_marcado ON patient_external_contacts;
CREATE TRIGGER trg_patient_external_contacts_bloqueia_apaga_telefone_marcado
  BEFORE UPDATE OF phone_encrypted ON patient_external_contacts
  FOR EACH ROW EXECUTE FUNCTION fn_patient_external_contacts_bloqueia_apaga_telefone_marcado();
