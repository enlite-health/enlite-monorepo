BEGIN;

-- ================================================================
-- Migration 438: patient source runs + snapshots + field map (spec 003)
-- ================================================================
-- Context: "Paciente — a plataforma é a fonte da verdade" (spec 003).
-- Reconciliação ClickUp × Ana Care → plataforma. As duas fontes são lidas por
-- API (a de paciente do Ana Care ainda vai existir — Gabriel, 27/08); nada de
-- arquivo/upload. Cada rodada tira uma
-- "foto" canônica de cada paciente como a fonte o vê; o diff e a decisão
-- humana (migration 440) trabalham sobre essas fotos, nunca sobre a fonte
-- viva.
--
-- O que cria:
--   1. patient_source_runs        — uma leitura de uma fonte (completude medida)
--   2. patient_source_snapshots   — um paciente como a fonte o vê, nessa rodada
--   3. source_field_map           — mapeamento declarado (fonte → campo canônico)
--   4. seed dos campos canônicos do ClickUp (34, do ClickUpPatientMapper)
--
-- Regras do parecer do lex (specs/003/lex-veredito.md):
--   C1  toda tabela nasce com country NOT NULL SEM default + policy de país
--       declarada aqui (inerte: RLS não é habilitada fora do QA — plano F1).
--   C2  `canonical` NUNCA contém contato/documento de responsável ou de
--       profissional tratante (o leitor remove antes de gravar; teste cobre).
--   (a) retenção = só o último snapshot por (source, external_id); hash igual
--       não grava linha nova (aplicado pelo SnapshotRepository).
--
-- Idempotent: safe to re-run (IF NOT EXISTS, ON CONFLICT DO NOTHING,
-- DROP POLICY IF EXISTS antes de CREATE POLICY).
-- Molde: migration 254 (patient_status_history).
-- ================================================================

-- ── 1. Runs ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS patient_source_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source          TEXT NOT NULL CHECK (source IN ('CLICKUP', 'ANACARE')),
  country         TEXT NOT NULL CHECK (country IN ('AR', 'BR')),
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ,
  expected_count  INTEGER,
  read_count      INTEGER NOT NULL DEFAULT 0,
  completeness    TEXT NOT NULL DEFAULT 'FAILED'
                  CHECK (completeness IN ('COMPLETE', 'PARTIAL', 'FAILED')),
  triggered_by    TEXT NOT NULL CHECK (triggered_by IN ('SCHEDULER', 'MANUAL')),
  actor_id        TEXT,
  error           TEXT
);

COMMENT ON TABLE patient_source_runs IS
  'Uma leitura de uma fonte externa de pacientes (API do ClickUp ou API do Ana Care). '
  'completeness=PARTIAL quando read_count < expected_count ou erro no meio — nunca '
  'apresentada como completa. error nunca contém linha de dado (só cabeçalho/nome de coluna). '
  'Migration 438 (spec 003).';
COMMENT ON COLUMN patient_source_runs.country IS
  'País do dado lido (C1 do lex). Sem default: quem lê declara.';

CREATE INDEX IF NOT EXISTS idx_patient_source_runs_source_started
  ON patient_source_runs (source, started_at DESC);

-- ── 2. Snapshots ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS patient_source_snapshots (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        UUID NOT NULL REFERENCES patient_source_runs(id) ON DELETE CASCADE,
  source        TEXT NOT NULL CHECK (source IN ('CLICKUP', 'ANACARE')),
  country       TEXT NOT NULL CHECK (country IN ('AR', 'BR')),
  external_id   TEXT NOT NULL,
  canonical     JSONB NOT NULL,
  content_hash  TEXT NOT NULL,
  read_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, source, external_id)
);

COMMENT ON TABLE patient_source_snapshots IS
  'Um paciente como a fonte o vê, já mapeado para o vocabulário canônico da plataforma. '
  'Retenção: só o último por (source, external_id) — o anterior é apagado quando o diff da '
  'rodada seguinte fecha; content_hash igual não grava (lex (a)). canonical NÃO contém '
  'contato/documento de responsável nem de profissional tratante (lex C2). '
  'Valor {"$unreadable": true} por campo = não consegui ler (D167), distinto de null = vazio. '
  'Migration 438 (spec 003).';

CREATE INDEX IF NOT EXISTS idx_patient_source_snapshots_source_ext
  ON patient_source_snapshots (source, external_id);
CREATE INDEX IF NOT EXISTS idx_patient_source_snapshots_run
  ON patient_source_snapshots (run_id);

-- ── 3. Field map ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS source_field_map (
  source           TEXT NOT NULL CHECK (source IN ('CLICKUP', 'ANACARE')),
  source_field     TEXT NOT NULL,
  canonical_field  TEXT NOT NULL,
  equivalence      TEXT NOT NULL CHECK (equivalence IN ('TEXT_NORM', 'DATE_ISO', 'ENUM_MAP', 'EXACT')),
  enum_map         TEXT,
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (source, source_field)
);

COMMENT ON TABLE source_field_map IS
  'Mapeamento declarado (não codificado) de campo da fonte → campo canônico, com a regra de '
  'equivalência usada no diff. ANACARE recebe linhas quando a lista de campos do Javier chegar '
  '(PEND-03). Migration 438 (spec 003).';

-- ── 4. Seed ClickUp (34 custom fields que o ClickUpPatientMapper consome) ────
-- source_field = nome EXATO do custom field no ClickUp (cf['...'] no mapper);
-- canonical_field = chave em CanonicalPatient (domain/CanonicalPatient.ts).
-- active=FALSE = contato/documento de RESPONSÁVEL: entra na base cifrado pelo
-- caminho normal do espelho, mas NUNCA no snapshot nem no diff (lex C2).
INSERT INTO source_field_map (source, source_field, canonical_field, equivalence, enum_map, active) VALUES
  ('CLICKUP', 'Nombre de Paciente',                     'firstName',               'TEXT_NORM', NULL,                   TRUE),
  ('CLICKUP', 'Apellido del Paciente',                  'lastName',                'TEXT_NORM', NULL,                   TRUE),
  ('CLICKUP', 'Fecha de Nacimiento',                    'birthDate',               'DATE_ISO',  NULL,                   TRUE),
  ('CLICKUP', 'Tipo de Documento Paciente',             'documentType',            'ENUM_MAP',  'documentTypeMap',      TRUE),
  ('CLICKUP', 'Número de Documento Paciente',           'documentNumber',          'EXACT',     NULL,                   TRUE),
  ('CLICKUP', 'Número ID Afiliado Paciente',            'healthInsuranceMemberId', 'EXACT',     NULL,                   TRUE),
  ('CLICKUP', 'Sexo Asignado al Nacer (Uso Clínico)',   'sex',                     'ENUM_MAP',  'sexMap',               TRUE),
  ('CLICKUP', 'Número de WhatsApp Paciente',            'phoneWhatsapp',           'EXACT',     NULL,                   TRUE),
  ('CLICKUP', 'Cobertura Informada',                    'healthInsuranceName',     'TEXT_NORM', NULL,                   TRUE),
  ('CLICKUP', 'Posee CUD',                              'hasCud',                  'EXACT',     NULL,                   TRUE),
  ('CLICKUP', 'Consentimiento',                         'hasConsent',              'EXACT',     NULL,                   TRUE),
  ('CLICKUP', 'Amparo Judicial',                        'hasJudicialProtection',   'EXACT',     NULL,                   TRUE),
  ('CLICKUP', 'Diagnóstico (si lo conoce)',             'diagnosis',               'TEXT_NORM', NULL,                   TRUE),
  ('CLICKUP', 'Dependencia',                            'dependencyLevel',         'ENUM_MAP',  'dependencyLevelMap',   TRUE),
  ('CLICKUP', 'Segmentos Clínicos',                     'clinicalSpecialty',       'ENUM_MAP',  'clinicalSpecialtyMap', TRUE),
  ('CLICKUP', 'Servicio',                               'serviceType',             'ENUM_MAP',  'serviceMap',           TRUE),
  ('CLICKUP', 'Comentarios Adicionales Paciente',       'additionalComments',      'TEXT_NORM', NULL,                   TRUE),
  ('CLICKUP', 'Provincia del Paciente',                 'province',                'TEXT_NORM', NULL,                   TRUE),
  ('CLICKUP', 'Ciudad / Localidad del Paciente',        'cityLocality',            'TEXT_NORM', NULL,                   TRUE),
  ('CLICKUP', 'Zona o Barrio Paciente',                 'zoneNeighborhood',        'TEXT_NORM', NULL,                   TRUE),
  ('CLICKUP', 'Domicilio 1 Principal Paciente',         'addresses',               'TEXT_NORM', NULL,                   TRUE),
  ('CLICKUP', 'Domicilio Informado Paciente 1',         'addresses',               'TEXT_NORM', NULL,                   TRUE),
  ('CLICKUP', 'Domicilio 2 Principal Paciente',         'addresses',               'TEXT_NORM', NULL,                   TRUE),
  ('CLICKUP', 'Domicilio Informado Paciente 2',         'addresses',               'TEXT_NORM', NULL,                   TRUE),
  ('CLICKUP', 'Domicilio 3 Principal Paciente',         'addresses',               'TEXT_NORM', NULL,                   TRUE),
  ('CLICKUP', 'Domicilio Informado Paciente 3',         'addresses',               'TEXT_NORM', NULL,                   TRUE),
  ('CLICKUP', 'Equipo Tratante Multidisciplinario',     'multidisciplinaryTeam',   'EXACT',     NULL,                   TRUE),
  ('CLICKUP', 'Nombre de Responsable',                  'responsibleFirstName',    'TEXT_NORM', NULL,                   TRUE),
  ('CLICKUP', 'Apellido de Responsable',                'responsibleLastName',     'TEXT_NORM', NULL,                   TRUE),
  ('CLICKUP', 'Relación con el Paciente',               'responsibleRelationship', 'ENUM_MAP',  'relationshipMap',      TRUE),
  ('CLICKUP', 'Número de WhatsApp Responsable',         'EXCLUDED_C2',             'EXACT',     NULL,                   FALSE),
  ('CLICKUP', 'Email del Responsable',                  'EXCLUDED_C2',             'EXACT',     NULL,                   FALSE),
  ('CLICKUP', 'Tipo de Documento Responsable',          'EXCLUDED_C2',             'EXACT',     NULL,                   FALSE),
  ('CLICKUP', 'Número de Documento Responsable',        'EXCLUDED_C2',             'EXACT',     NULL,                   FALSE)
ON CONFLICT (source, source_field) DO NOTHING;

-- ── 5. Policies de país (C1) — declaradas, NÃO habilitadas (plano F1) ────────
DROP POLICY IF EXISTS patient_source_runs_country ON patient_source_runs;
CREATE POLICY patient_source_runs_country ON patient_source_runs
  USING (country = current_setting('app.country', true));
DROP POLICY IF EXISTS patient_source_snapshots_country ON patient_source_snapshots;
CREATE POLICY patient_source_snapshots_country ON patient_source_snapshots
  USING (country = current_setting('app.country', true));

COMMIT;
