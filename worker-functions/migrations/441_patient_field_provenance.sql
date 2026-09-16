BEGIN;

-- ================================================================
-- Migration 441: patient field provenance + origin 'anacare' (spec 003)
-- ================================================================
-- Context: passo 5 do modelo — a carga grava cada campo decidido e precisa
-- dizer DE ONDE veio o valor atual (ClickUp / Ana Care / manual /
-- reconciliação). patients.origin (migration 251) é por LINHA; a
-- proveniência por CAMPO vive aqui. Pacientes que só existiam no Ana
-- Care nascem com origin='anacare'.
--
-- O que cria/altera:
--   1. patient_field_provenance (PK patient_id+field)
--   2. patients.origin CHECK ganha 'anacare'
--
-- lex C1: country NOT NULL sem default + policy declarada (inerte).
-- lex C9: paciente origin='anacare' nasce com country explícito e
-- has_consent decidido — enforçado no ApplyReconciliationUseCase (T046),
-- não aqui (a coluna has_consent é nullable por desenho da 037).
-- Idempotent. Molde: migration 254; CHECK: molde da 251.
-- ================================================================

-- ── 1. Provenance ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS patient_field_provenance (
  patient_id   UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  field        TEXT NOT NULL,
  country      TEXT NOT NULL CHECK (country IN ('AR', 'BR')),
  source       TEXT NOT NULL CHECK (source IN ('CLICKUP', 'ANACARE', 'MANUAL', 'RECONCILIATION')),
  run_id       UUID REFERENCES patient_source_runs(id) ON DELETE SET NULL,
  decision_id  UUID REFERENCES patient_reconciliation_decisions(id) ON DELETE SET NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (patient_id, field)
);

COMMENT ON TABLE patient_field_provenance IS
  'De onde veio o valor ATUAL de cada campo do paciente (por campo; patients.origin é por linha). '
  'Escrita pela carga da reconciliação junto com patient_field_overrides_audit '
  '(source=RECONCILIATION_REVIEW). Sem valor: só a origem. Migration 441 (spec 003).';

-- ── 2. patients.origin ganha 'anacare' ───────────────────────────────────────
ALTER TABLE patients DROP CONSTRAINT IF EXISTS patients_origin_check;
ALTER TABLE patients ADD CONSTRAINT patients_origin_check
  CHECK (origin IN ('clickup', 'web_form', 'admin_manual', 'anacare'));

COMMENT ON COLUMN patients.origin IS
  'Origem da LINHA: clickup (espelho), web_form (lead público), admin_manual (criado no painel), '
  'anacare (só existia no Ana Care; entrou pela reconciliação — spec 003, migration 441).';

-- ── 3. Policy de país (C1) — declarada, NÃO habilitada ───────────────────────
DROP POLICY IF EXISTS patient_field_provenance_country ON patient_field_provenance;
CREATE POLICY patient_field_provenance_country ON patient_field_provenance
  USING (country = current_setting('app.country', true));

COMMIT;
