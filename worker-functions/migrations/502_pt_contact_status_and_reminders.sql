-- 502 — Projeto Terapêutico: "Todavía no hay registro" / "No necesita" nos 4 campos de contato + lembretes (spec 048)
--
-- POR QUÊ: a versão do PT (416) e a ligação versão→contato (429) são IMUTÁVEIS, e lista vazia já significa
-- "nada informado" — não dá para guardar "ainda não há" como lista vazia nem como coluna da versão. O estado de
-- cada campo nasce numa tabela NOVA, no INSERT da versão (molde 429). Os lembretes (dias 2, 5 e 12) são uma OUTBOX:
-- o ciclo nasce na transação que cria a versão; um Cloud Scheduler diário varre a tabela (sem Cloud Tasks).
--
-- O QUE FAZ: A) status por campo/versão · B) ciclo de lembretes por paciente (no máximo UM aberto — índice único)
-- C) lembretes (UNIQUE ciclo+dia, carimbo que não "des-envia") · D) tipo de notificação do sino ·
-- E) 2 células novas ao Acesso Master (placeholder em iam.permissions ANTES do grant — molde 463).
-- NÃO mexe em nenhum outro grupo. Nunca remove grant.
--
-- ROLLBACK: migrations/pending/ROLLBACK_502_pt_contact_status_and_reminders.sql

BEGIN;

-- ── A. Status por campo, por versão ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS patient_therapeutic_project_contact_status (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id     UUID         NOT NULL REFERENCES patient_therapeutic_projects(id) ON DELETE CASCADE,
  patient_id     UUID         NOT NULL,
  contact_kind   TEXT         NOT NULL CHECK (contact_kind IN ('RESPONSIBLE', 'EXTERNAL', 'COVERAGE', 'CARE_TEAM')),
  status         TEXT         NOT NULL CHECK (status IN ('PENDING', 'NOT_NEEDED')),
  -- Âncora do PRAZO do campo: a 1ª versão em que ficou PENDING; herdada enquanto continuar PENDING.
  pending_since  TIMESTAMPTZ  NULL,
  -- Quem marcou (autor da versão em que o campo ficou PENDING/NOT_NEEDED pela 1ª vez; herdado junto). Nunca sai na API.
  marked_by_uid  VARCHAR(128) NOT NULL,
  country        TEXT         NULL,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT ptpcs_um_por_campo UNIQUE (version_id, contact_kind),
  CONSTRAINT ptpcs_prazo_coerente CHECK (
       (status = 'PENDING'    AND pending_since IS NOT NULL)
    OR (status = 'NOT_NEEDED' AND pending_since IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_ptpcs_patient ON patient_therapeutic_project_contact_status (patient_id);
CREATE INDEX IF NOT EXISTS idx_ptpcs_country ON patient_therapeutic_project_contact_status (country);

-- País herdado do paciente (molde 429, etapa 1).
CREATE OR REPLACE FUNCTION fn_ptpcs_country_from_patient()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.country IS NULL THEN
    SELECT p.country INTO NEW.country FROM patients p WHERE p.id = NEW.patient_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ptpcs_country ON patient_therapeutic_project_contact_status;
CREATE TRIGGER trg_ptpcs_country
  BEFORE INSERT ON patient_therapeutic_project_contact_status
  FOR EACH ROW EXECUTE FUNCTION fn_ptpcs_country_from_patient();

ALTER TABLE patient_therapeutic_project_contact_status ALTER COLUMN country SET NOT NULL;
ALTER TABLE patient_therapeutic_project_contact_status DROP CONSTRAINT IF EXISTS ptpcs_country_check;
ALTER TABLE patient_therapeutic_project_contact_status
  ADD CONSTRAINT ptpcs_country_check CHECK (country IN ('AR', 'BR'));

-- Imutabilidade (molde 429): INSERT só na transação que criou a versão; UPDATE nunca; DELETE só sem o paciente-pai.
-- A mais: o MESMO (version_id, contact_kind) não pode ter contato — o status e a lista são excludentes.
CREATE OR REPLACE FUNCTION fn_ptpcs_imutavel()
RETURNS TRIGGER AS $$
DECLARE
  v_created_at TIMESTAMPTZ;
  v_patient_id UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM patients p WHERE p.id = OLD.patient_id) THEN
      RAISE EXCEPTION 'ptpcs_imutavel: status do campo não se apaga isoladamente' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'ptpcs_imutavel: status do campo não se edita — crie a versão seguinte' USING ERRCODE = '55000';
  END IF;

  SELECT created_at, patient_id INTO v_created_at, v_patient_id
    FROM patient_therapeutic_projects WHERE id = NEW.version_id;
  IF v_created_at IS NULL THEN
    RAISE EXCEPTION 'ptpcs_versao_inexistente: version_id não existe' USING ERRCODE = '23503';
  END IF;
  IF v_patient_id IS DISTINCT FROM NEW.patient_id THEN
    RAISE EXCEPTION 'ptpcs_versao_de_outro_paciente: version_id não pertence a patient_id' USING ERRCODE = '23503';
  END IF;
  IF v_created_at <> now() THEN
    RAISE EXCEPTION 'ptpcs_fora_da_transacao: status só se insere na transação que cria a versão'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM patient_therapeutic_project_contacts c
     WHERE c.version_id = NEW.version_id AND c.contact_kind = NEW.contact_kind
  ) THEN
    RAISE EXCEPTION 'ptpcs_status_com_contato: campo com contato escolhido não tem status'
      USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ptpcs_imutavel ON patient_therapeutic_project_contact_status;
CREATE TRIGGER trg_ptpcs_imutavel
  BEFORE INSERT OR UPDATE OR DELETE ON patient_therapeutic_project_contact_status
  FOR EACH ROW EXECUTE FUNCTION fn_ptpcs_imutavel();

ALTER TABLE patient_therapeutic_project_contact_status ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ptpcs_follow_patient ON patient_therapeutic_project_contact_status;
CREATE POLICY ptpcs_follow_patient ON patient_therapeutic_project_contact_status FOR ALL USING (
  (
    NULLIF(current_setting('app.system_context', true), '') IS NOT NULL
    AND pg_has_role(current_user, 'app_system', 'MEMBER')
  )
  OR EXISTS (SELECT 1 FROM patients p WHERE p.id = patient_therapeutic_project_contact_status.patient_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON patient_therapeutic_project_contact_status TO app_runtime, app_system;

COMMENT ON TABLE patient_therapeutic_project_contact_status IS
  'Estado explícito de um campo de contato do PT por versão: PENDING ("Todavía no hay registro", prazo 15 dias) ou '
  'NOT_NEEDED ("No necesita"). Imutável, só na transação da versão (spec 048). Só ids/enum — nunca texto. '
  'REVOGADA do enlite_mcp_ro (revela "família não informada" do paciente).';

-- ── B. Ciclo de lembretes por paciente (P6: no máximo UM aberto — invariante do BANCO) ─────────
CREATE TABLE IF NOT EXISTS patient_tp_contact_reminder_cycles (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id         UUID         NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  anchor_version_id  UUID         NOT NULL REFERENCES patient_therapeutic_projects(id) ON DELETE CASCADE,
  anchored_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  opened_by_uid      VARCHAR(128) NOT NULL,
  closed_at          TIMESTAMPTZ  NULL,
  close_reason       TEXT         NULL CHECK (close_reason IN ('RESOLVED', 'COMPLETED', 'NO_CURRENT_VERSION')),
  country            TEXT         NULL,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT ptcrc_fecho_coerente CHECK ((closed_at IS NULL) = (close_reason IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ptcrc_um_aberto_por_paciente
  ON patient_tp_contact_reminder_cycles (patient_id) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ptcrc_country ON patient_tp_contact_reminder_cycles (country);

CREATE OR REPLACE FUNCTION fn_ptcrc_country_from_patient()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.country IS NULL THEN
    SELECT p.country INTO NEW.country FROM patients p WHERE p.id = NEW.patient_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ptcrc_country ON patient_tp_contact_reminder_cycles;
CREATE TRIGGER trg_ptcrc_country
  BEFORE INSERT ON patient_tp_contact_reminder_cycles
  FOR EACH ROW EXECUTE FUNCTION fn_ptcrc_country_from_patient();

ALTER TABLE patient_tp_contact_reminder_cycles ALTER COLUMN country SET NOT NULL;
ALTER TABLE patient_tp_contact_reminder_cycles DROP CONSTRAINT IF EXISTS ptcrc_country_check;
ALTER TABLE patient_tp_contact_reminder_cycles
  ADD CONSTRAINT ptcrc_country_check CHECK (country IN ('AR', 'BR'));

ALTER TABLE patient_tp_contact_reminder_cycles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ptcrc_follow_patient ON patient_tp_contact_reminder_cycles;
CREATE POLICY ptcrc_follow_patient ON patient_tp_contact_reminder_cycles FOR ALL USING (
  (
    NULLIF(current_setting('app.system_context', true), '') IS NOT NULL
    AND pg_has_role(current_user, 'app_system', 'MEMBER')
  )
  OR EXISTS (SELECT 1 FROM patients p WHERE p.id = patient_tp_contact_reminder_cycles.patient_id)
);

GRANT SELECT, INSERT, UPDATE ON patient_tp_contact_reminder_cycles TO app_runtime, app_system;

-- ── D (antes de C: C referencia notification_events) Tipo de notificação ────────────────────────
INSERT INTO notification_types (code, description) VALUES
  ('THERAPEUTIC_PROJECT_CONTACTS_PENDING',
   'Lembrete automático: o Projeto Terapêutico do paciente tem contatos marcados "Todavía no hay registro" (dias 2, 5 e 12)')
ON CONFLICT (code) DO NOTHING;

-- ── C. Lembretes = a OUTBOX que o Scheduler varre ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS patient_tp_contact_reminders (
  id                     UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id               UUID         NOT NULL REFERENCES patient_tp_contact_reminder_cycles(id) ON DELETE CASCADE,
  day_offset             SMALLINT     NOT NULL CHECK (day_offset IN (2, 5, 12)),
  due_at                 TIMESTAMPTZ  NOT NULL,
  sent_at                TIMESTAMPTZ  NULL,
  notification_event_id  UUID         NULL REFERENCES notification_events(id) ON DELETE SET NULL,
  skipped_reason         TEXT         NULL CHECK (skipped_reason IN ('NO_ACTIVE_RECIPIENT')),
  cancelled_at           TIMESTAMPTZ  NULL,
  cancel_reason          TEXT         NULL CHECK (cancel_reason IN ('RESOLVED', 'SUPERSEDED', 'NO_CURRENT_VERSION')),
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT ptcr_um_por_dia UNIQUE (cycle_id, day_offset),
  CONSTRAINT ptcr_desfecho_unico CHECK (NOT (sent_at IS NOT NULL AND cancelled_at IS NOT NULL)),
  CONSTRAINT ptcr_cancel_coerente CHECK ((cancelled_at IS NULL) = (cancel_reason IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_ptcr_fila ON patient_tp_contact_reminders (due_at)
  WHERE sent_at IS NULL AND cancelled_at IS NULL;

-- Carimbo que não volta: sent_at/cancelled_at/... só vão de NULL para valor; id/ciclo/dia/criação imutáveis.
-- `due_at` fica mutável DE PROPÓSITO (único "relógio" que o e2e adianta sem expor `asOf` no endpoint de prd).
CREATE OR REPLACE FUNCTION fn_ptcr_carimbo_unico()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.cycle_id IS DISTINCT FROM OLD.cycle_id
     OR NEW.day_offset IS DISTINCT FROM OLD.day_offset
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'ptcr_imutavel: id/ciclo/dia do lembrete não mudam' USING ERRCODE = '55000';
  END IF;
  IF (OLD.sent_at IS NOT NULL AND NEW.sent_at IS DISTINCT FROM OLD.sent_at)
     OR (OLD.cancelled_at IS NOT NULL AND NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at)
     OR (OLD.cancel_reason IS NOT NULL AND NEW.cancel_reason IS DISTINCT FROM OLD.cancel_reason)
     OR (OLD.skipped_reason IS NOT NULL AND NEW.skipped_reason IS DISTINCT FROM OLD.skipped_reason)
     OR (OLD.notification_event_id IS NOT NULL AND NEW.notification_event_id IS NOT NULL
         AND NEW.notification_event_id IS DISTINCT FROM OLD.notification_event_id) THEN
    RAISE EXCEPTION 'ptcr_carimbo_unico: lembrete já desfechado não se reabre nem se reescreve' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ptcr_carimbo_unico ON patient_tp_contact_reminders;
CREATE TRIGGER trg_ptcr_carimbo_unico
  BEFORE UPDATE ON patient_tp_contact_reminders
  FOR EACH ROW EXECUTE FUNCTION fn_ptcr_carimbo_unico();

ALTER TABLE patient_tp_contact_reminders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ptcr_follow_cycle ON patient_tp_contact_reminders;
CREATE POLICY ptcr_follow_cycle ON patient_tp_contact_reminders FOR ALL USING (
  (
    NULLIF(current_setting('app.system_context', true), '') IS NOT NULL
    AND pg_has_role(current_user, 'app_system', 'MEMBER')
  )
  OR EXISTS (SELECT 1 FROM patient_tp_contact_reminder_cycles c WHERE c.id = patient_tp_contact_reminders.cycle_id)
);

GRANT SELECT, INSERT, UPDATE ON patient_tp_contact_reminders TO app_runtime, app_system;

COMMENT ON TABLE patient_tp_contact_reminders IS
  'Outbox dos lembretes (dias 2/5/12) do PT com contato "Todavía no hay registro" (spec 048). Uma linha por lembrete por PACIENTE (ciclo), '
  'varrida por Cloud Scheduler diário; sent_at e a notificação do sino são gravados na MESMA transação (idempotência).';

-- ── E. 2 células ao Master (molde 463: placeholder ANTES do grant; não depende da ordem migration → sync) ──
DO $$
DECLARE
  v_master_id CONSTANT UUID := 'a0000000-0000-0000-0000-000000000001';
  v_n INT;
BEGIN
  IF to_regclass('iam.permissions') IS NOT NULL THEN
    INSERT INTO iam.permissions (resource, action, description, category, owner_service, deprecated_at)
    VALUES
      ('patient_therapeutic_project', 'waive_contact',
       '[502 placeholder — sincronizado no boot] Ver e escolher "No necesita" nos campos de contato do projeto terapêutico.',
       'Pacientes', 'worker-functions', NULL),
      ('patient_therapeutic_project', 'incomplete_alert',
       '[502 placeholder — sincronizado no boot] Receber o aviso do 12º dia de projeto terapêutico com contatos pendentes.',
       'Pacientes', 'worker-functions', NULL)
    ON CONFLICT (resource, action) DO NOTHING;
  END IF;

  IF to_regclass('iam.permission_groups') IS NOT NULL THEN
    INSERT INTO iam.group_permissions (group_id, permission_id)
    SELECT v_master_id, p.id
      FROM iam.permissions p
     WHERE p.resource = 'patient_therapeutic_project'
       AND p.action IN ('waive_contact', 'incomplete_alert')
       AND p.deprecated_at IS NULL
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE '[502] grant explícito ao Acesso Master: % células novas (spec 048)', v_n;
  END IF;
END
$$;

COMMIT;
