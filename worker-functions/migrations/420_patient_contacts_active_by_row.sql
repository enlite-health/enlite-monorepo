-- 420 — Identidade estável e escrita por linha: `active`/`deactivated_*` nos três conjuntos de
-- contato do paciente (spec 018, PR-1, ADR-1; US-0; FR-001…006).
--
-- Hoje responsáveis (136), contatos de emergência da cobertura (417) e equipe tratante (038/068/071)
-- são gravados por "apaga tudo e insere de novo" (`replaceAll`/`replacePatientProfessionals`): cada
-- edição dá id novo a todo mundo, e nada pode apontar de forma estável para um contato (a marca de
-- emergência do PR-2 e a seleção do projeto terapêutico do PR-7 precisam do id sobrevivendo à edição).
--
-- Molde do CHECK `active ⇔ deactivated_at IS NULL`: `415_therapeutic_catalogs.sql:46`.
--
-- Rollback: DROP dos dois índices novos, DROP das constraints `_active_coerente`, DROP das colunas
-- `active`/`deactivated_at`/`deactivated_by` (+ `updated_at`/`created_by` onde esta migration as
-- criou) e recriação do índice antigo `idx_patient_responsibles_one_primary` (sem o `AND active`).

-- ── patient_responsibles (136) ────────────────────────────────────────────────────────────────
ALTER TABLE patient_responsibles ADD COLUMN IF NOT EXISTS active          BOOLEAN      NOT NULL DEFAULT true;
ALTER TABLE patient_responsibles ADD COLUMN IF NOT EXISTS deactivated_at  TIMESTAMPTZ  NULL;
ALTER TABLE patient_responsibles ADD COLUMN IF NOT EXISTS deactivated_by  VARCHAR(128) NULL;
-- Legado sem autor de criação (a coluna nasce agora; linhas do ClickUp e antigas ficam NULL).
ALTER TABLE patient_responsibles ADD COLUMN IF NOT EXISTS created_by      VARCHAR(128) NULL;
ALTER TABLE patient_responsibles DROP CONSTRAINT IF EXISTS patient_responsibles_active_coerente;
ALTER TABLE patient_responsibles ADD CONSTRAINT patient_responsibles_active_coerente
  CHECK ((active AND deactivated_at IS NULL) OR (NOT active AND deactivated_at IS NOT NULL));

-- "No máximo 1 titular por paciente" passa a olhar só linhas ATIVAS — hoje o índice não filtra,
-- então desativar o titular não abre espaço para outro.
DROP INDEX IF EXISTS idx_patient_responsibles_one_primary;
CREATE UNIQUE INDEX idx_patient_responsibles_one_primary
  ON patient_responsibles(patient_id)
  WHERE is_primary AND active;

CREATE INDEX IF NOT EXISTS idx_patient_responsibles_patient_active
  ON patient_responsibles(patient_id) WHERE active;

-- ── patient_coverage_emergency_contacts (417) ─────────────────────────────────────────────────
ALTER TABLE patient_coverage_emergency_contacts ADD COLUMN IF NOT EXISTS active          BOOLEAN      NOT NULL DEFAULT true;
ALTER TABLE patient_coverage_emergency_contacts ADD COLUMN IF NOT EXISTS deactivated_at  TIMESTAMPTZ  NULL;
ALTER TABLE patient_coverage_emergency_contacts ADD COLUMN IF NOT EXISTS deactivated_by  VARCHAR(128) NULL;
-- A tabela nasceu (417) sem `updated_at` — a escrita por linha (UPDATE parcial) passa a precisar dele.
ALTER TABLE patient_coverage_emergency_contacts ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now();
ALTER TABLE patient_coverage_emergency_contacts DROP CONSTRAINT IF EXISTS pcec_active_coerente;
ALTER TABLE patient_coverage_emergency_contacts ADD CONSTRAINT pcec_active_coerente
  CHECK ((active AND deactivated_at IS NULL) OR (NOT active AND deactivated_at IS NOT NULL));

CREATE INDEX IF NOT EXISTS idx_patient_coverage_emergency_contacts_patient_active
  ON patient_coverage_emergency_contacts(patient_id) WHERE active;

-- ── patient_professionals (038/068/071) — equipe tratante ─────────────────────────────────────
-- A escrita por linha da equipe é PR-5; esta migration só abre a coluna (mesmo molde, mesma
-- migration única para os TRÊS conjuntos — data-model.md §420) para não repetir DDL depois.
ALTER TABLE patient_professionals ADD COLUMN IF NOT EXISTS active          BOOLEAN      NOT NULL DEFAULT true;
ALTER TABLE patient_professionals ADD COLUMN IF NOT EXISTS deactivated_at  TIMESTAMPTZ  NULL;
ALTER TABLE patient_professionals ADD COLUMN IF NOT EXISTS deactivated_by  VARCHAR(128) NULL;
ALTER TABLE patient_professionals ADD COLUMN IF NOT EXISTS created_by      VARCHAR(128) NULL;
ALTER TABLE patient_professionals DROP CONSTRAINT IF EXISTS patient_professionals_active_coerente;
ALTER TABLE patient_professionals ADD CONSTRAINT patient_professionals_active_coerente
  CHECK ((active AND deactivated_at IS NULL) OR (NOT active AND deactivated_at IS NOT NULL));

CREATE INDEX IF NOT EXISTS idx_patient_professionals_patient_active
  ON patient_professionals(patient_id) WHERE active;

COMMENT ON COLUMN patient_responsibles.active IS
  'Escrita por linha (spec 018 PR-1, ADR-1): false = removido pelo painel, nunca DELETE. Leituras (ficha, completude, MISSING_SQL.RESPONSIBLE) filtram active.';
COMMENT ON COLUMN patient_coverage_emergency_contacts.active IS
  'Escrita por linha (spec 018 PR-1, ADR-1): false = removido pelo painel, nunca DELETE.';
COMMENT ON COLUMN patient_professionals.active IS
  'Coluna aberta no PR-1 (spec 018) para a escrita por linha da equipe tratante, que chega no PR-5.';
