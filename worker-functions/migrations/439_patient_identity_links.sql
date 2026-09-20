BEGIN;

-- ================================================================
-- Migration 439: patient identity links + inventory view (spec 003)
-- ================================================================
-- Context: "este registro externo é esta pessoa". A chave do espelho
-- ClickUp é a TASK (1 task = 1 caso, migration 037) — a reconciliação
-- precisa de identidade por PESSOA. Um link liga (source, external_id) a
-- um patient_id; o estado diz se foi automático, ambíguo (fila do
-- Gabriel), confirmado ou negado. DENIED nunca volta a AUTO pela chave.
--
-- O que cria:
--   1. patient_identity_links
--   2. v_patient_source_inventory — os quatro conjuntos (só ClickUp, só
--      Ana Care, nos dois, ambíguos) derivados dos links vivos
--
-- lex C1: country NOT NULL sem default + policy declarada (inerte).
-- Idempotent: IF NOT EXISTS / CREATE OR REPLACE VIEW / DROP POLICY IF EXISTS.
-- Molde: migration 254.
-- ================================================================

-- ── 1. Links ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS patient_identity_links (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source                TEXT NOT NULL CHECK (source IN ('CLICKUP', 'ANACARE')),
  country               TEXT NOT NULL CHECK (country IN ('AR', 'BR')),
  external_id           TEXT NOT NULL,
  patient_id            UUID REFERENCES patients(id) ON DELETE SET NULL,
  match_key             TEXT NOT NULL CHECK (match_key IN ('EXTERNAL_ID', 'DOCUMENT', 'NAME_BIRTHDATE', 'MANUAL', 'NONE')),
  state                 TEXT NOT NULL CHECK (state IN ('AUTO', 'AMBIGUOUS', 'CONFIRMED', 'DENIED')),
  candidate_patient_id  UUID REFERENCES patients(id) ON DELETE SET NULL,
  last_run_id           UUID REFERENCES patient_source_runs(id) ON DELETE SET NULL,
  decided_by            TEXT,
  decided_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source, external_id)
);

COMMENT ON TABLE patient_identity_links IS
  'Liga um registro de fonte externa a uma pessoa da plataforma. state: AUTO (chave bateu), '
  'AMBIGUOUS (bateu em parte — fila de decisão; candidate_patient_id é o candidato), CONFIRMED / '
  'DENIED (decisão humana; DENIED faz a chave deixar de valer para o par). match_key NONE = '
  'só existe na fonte, ainda sem pessoa. last_run_id = última rodada em que a fonte trouxe este '
  'registro (ausência em rodada COMPLETE = sumiu da fonte). Migration 439 (spec 003).';

CREATE INDEX IF NOT EXISTS idx_patient_identity_links_patient
  ON patient_identity_links (patient_id);
CREATE INDEX IF NOT EXISTS idx_patient_identity_links_state
  ON patient_identity_links (state) WHERE state = 'AMBIGUOUS';

-- ── 2. Inventory view ────────────────────────────────────────────────────────
-- Um paciente conta em "both" quando tem link vivo (não DENIED) nas duas
-- fontes apontando para o mesmo patient_id. "only_*" = link vivo numa fonte e
-- nenhum link vivo na outra para a mesma pessoa (ou pessoa ainda sem patient_id).
CREATE OR REPLACE VIEW v_patient_source_inventory AS
WITH live AS (
  SELECT id, source, country, external_id, patient_id, state
    FROM patient_identity_links
   WHERE state <> 'DENIED'
),
per_person AS (
  SELECT COALESCE(patient_id::text, source || ':' || external_id) AS person_key,
         country,
         BOOL_OR(source = 'CLICKUP') AS in_clickup,
         BOOL_OR(source = 'ANACARE') AS in_anacare,
         BOOL_OR(state = 'AMBIGUOUS') AS ambiguous
    FROM live
   GROUP BY 1, 2
)
SELECT person_key,
       country,
       CASE
         WHEN ambiguous              THEN 'AMBIGUOUS'
         WHEN in_clickup AND in_anacare THEN 'BOTH'
         WHEN in_clickup             THEN 'ONLY_CLICKUP'
         ELSE                             'ONLY_ANACARE'
       END AS bucket
  FROM per_person;

COMMENT ON VIEW v_patient_source_inventory IS
  'Classificação derivada dos links vivos: ONLY_CLICKUP / ONLY_ANACARE / BOTH / AMBIGUOUS, uma '
  'linha por pessoa (patient_id ou, sem pessoa, source:external_id). Migration 439 (spec 003).';

-- ── 3. Policy de país (C1) — declarada, NÃO habilitada ───────────────────────
DROP POLICY IF EXISTS patient_identity_links_country ON patient_identity_links;
CREATE POLICY patient_identity_links_country ON patient_identity_links
  USING (country = current_setting('app.country', true));

COMMIT;
