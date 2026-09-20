BEGIN;

-- ================================================================
-- Migration 440: reconciliation items, decisions, bulk rules (spec 003)
-- ================================================================
-- Context: passo 3 e 4 do modelo — para cada paciente que está NAS DUAS
-- fontes, o diff campo a campo gera um ITEM por campo diferente ("igual"
-- não gera item). O Gabriel decide cada item (ou por regra em lote por
-- campo); a decisão fica registrada com ator e hora. NADA é gravado na
-- base para um campo com item PENDING (FR-007).
--
-- O que cria:
--   1. patient_reconciliation_items
--   2. patient_reconciliation_bulk_rules
--   3. patient_reconciliation_decisions
--
-- Regras do lex: C1 country NOT NULL sem default + policy declarada;
-- (a)/C5: value_* e chosen_value guardam valor clínico — são PURGADOS
-- (postos a NULL) depois de aplicados + no soft-delete do paciente,
-- preservando chosen_source/actor/hora (D94: some o dado, fica a trilha).
-- Sem undo: nova decisão para o mesmo item = nova linha.
-- Idempotent. Molde: migration 254.
-- ================================================================

-- ── 1. Items ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS patient_reconciliation_items (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_pair_id    UUID NOT NULL,
  clickup_run_id UUID REFERENCES patient_source_runs(id) ON DELETE SET NULL,
  anacare_run_id UUID REFERENCES patient_source_runs(id) ON DELETE SET NULL,
  patient_id     UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  country        TEXT NOT NULL CHECK (country IN ('AR', 'BR')),
  field          TEXT NOT NULL,
  value_clickup  JSONB,
  value_anacare  JSONB,
  equivalence    TEXT NOT NULL CHECK (equivalence IN ('TEXT_NORM', 'DATE_ISO', 'ENUM_MAP', 'EXACT', 'UNMAPPED')),
  state          TEXT NOT NULL DEFAULT 'PENDING'
                 CHECK (state IN ('PENDING', 'DECIDED', 'SUPERSEDED')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_pair_id, patient_id, field)
);

COMMENT ON TABLE patient_reconciliation_items IS
  'Uma diferença campo a campo entre ClickUp e Ana Care para um paciente presente nos dois. '
  'value_* : NULL = vazio na fonte; {"$unreadable":true} = não consegui ler (D167). '
  'SUPERSEDED = a fonte mudou depois da decisão; nasce um novo PENDING. Item PENDING implica '
  'patients.needs_attention=true (RECONCILIATION_PENDING). Valores são purgados após aplicação '
  '(lex (a)/C5). Migration 440 (spec 003).';

CREATE INDEX IF NOT EXISTS idx_patient_reconciliation_items_pending
  ON patient_reconciliation_items (patient_id, field) WHERE state = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_patient_reconciliation_items_field_pending
  ON patient_reconciliation_items (field) WHERE state = 'PENDING';

-- ── 2. Bulk rules ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS patient_reconciliation_bulk_rules (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  country        TEXT NOT NULL CHECK (country IN ('AR', 'BR')),
  field          TEXT NOT NULL,
  chosen_source  TEXT NOT NULL CHECK (chosen_source IN ('CLICKUP', 'ANACARE')),
  actor_id       TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at     TIMESTAMPTZ
);

COMMENT ON TABLE patient_reconciliation_bulk_rules IS
  '"Para o campo X vale sempre a fonte Y": aplicar = gerar uma decisão por item PENDING do campo, '
  'cada uma auditada individualmente; revogar não apaga decisões já criadas. Migration 440 (spec 003).';

-- ── 3. Decisions ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS patient_reconciliation_decisions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id        UUID NOT NULL REFERENCES patient_reconciliation_items(id) ON DELETE CASCADE,
  country        TEXT NOT NULL CHECK (country IN ('AR', 'BR')),
  chosen_source  TEXT NOT NULL CHECK (chosen_source IN ('CLICKUP', 'ANACARE', 'MANUAL')),
  chosen_value   JSONB,
  bulk_rule_id   UUID REFERENCES patient_reconciliation_bulk_rules(id) ON DELETE SET NULL,
  actor_id       TEXT NOT NULL,
  decided_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_at     TIMESTAMPTZ,
  value_purged_at TIMESTAMPTZ
);

COMMENT ON TABLE patient_reconciliation_decisions IS
  'O Gabriel decidiu: fonte escolhida (ou valor MANUAL), quem, quando, se veio de regra em lote, '
  'quando a carga aplicou. chosen_value é purgado (NULL + value_purged_at) depois de aplicado; '
  'chosen_source/actor/decided_at ficam — a trilha não se apaga (D94). Sem undo: nova decisão = '
  'nova linha. Migration 440 (spec 003).';

CREATE INDEX IF NOT EXISTS idx_patient_reconciliation_decisions_item
  ON patient_reconciliation_decisions (item_id, decided_at DESC);

-- ── 4. Policies de país (C1) — declaradas, NÃO habilitadas ───────────────────
DROP POLICY IF EXISTS patient_reconciliation_items_country ON patient_reconciliation_items;
CREATE POLICY patient_reconciliation_items_country ON patient_reconciliation_items
  USING (country = current_setting('app.country', true));
DROP POLICY IF EXISTS patient_reconciliation_bulk_rules_country ON patient_reconciliation_bulk_rules;
CREATE POLICY patient_reconciliation_bulk_rules_country ON patient_reconciliation_bulk_rules
  USING (country = current_setting('app.country', true));
DROP POLICY IF EXISTS patient_reconciliation_decisions_country ON patient_reconciliation_decisions;
CREATE POLICY patient_reconciliation_decisions_country ON patient_reconciliation_decisions
  USING (country = current_setting('app.country', true));

COMMIT;
