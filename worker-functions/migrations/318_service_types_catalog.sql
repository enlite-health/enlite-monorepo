-- 318 — `service_types`: catálogo do serviço contratado (spec 013, bloco C — US-C1)
--
-- ── Por que catálogo, não CHECK ─────────────────────────────────────────────
-- Mesmo raciocínio da 307 (`device_types`): o código precisa ser referenciável por FK
-- (`patient_contracted_services.service_code`) e editável sem deploy. É o MESMO vocabulário de
-- `workers.profession` (migration 064) e de `patients.service_type[]` (migration 139, CHECK
-- fechado nos 5 valores abaixo) — por isso os códigos AQUI são exatamente os 5 de `Profession`
-- (`src/modules/worker/domain/enums/Profession.ts`), não um vocabulário novo.
--
-- Molde: 307 (device_types) e 311 (insurance_providers) — catálogo + tabela de aliases (ConceptMap)
-- separada, `ON CONFLICT DO NOTHING` no seed (catálogo é dado de operação a partir daqui).
--
-- Rollback: DROP TABLE service_type_aliases; DROP TABLE service_types; — nascem populadas pelo
-- seed abaixo; nenhuma tabela do bloco C existe ainda nesta árvore, então não há FK a desfazer.

CREATE TABLE IF NOT EXISTS service_types (
  code        TEXT        PRIMARY KEY,
  active      BOOLEAN     NOT NULL DEFAULT true,
  retired_at  TIMESTAMPTZ NULL,
  sort_order  SMALLINT    NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT service_types_code_upper
    CHECK (code = upper(code) AND code ~ '^[A-Z][A-Z0-9_]*$'),
  CONSTRAINT service_types_sort_order_unico
    UNIQUE (sort_order),
  CONSTRAINT service_types_retired_coerente
    CHECK ((active AND retired_at IS NULL) OR (NOT active AND retired_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS service_type_aliases (
  source TEXT NOT NULL DEFAULT 'clickup',
  label  TEXT NOT NULL,
  code   TEXT NOT NULL REFERENCES service_types(code) ON UPDATE CASCADE,
  CONSTRAINT service_type_aliases_pkey PRIMARY KEY (source, label),
  CONSTRAINT service_type_aliases_label_not_blank CHECK (btrim(label) <> '')
);

CREATE INDEX IF NOT EXISTS idx_service_type_aliases_code
  ON service_type_aliases (code);

COMMENT ON TABLE service_types IS
  'Catálogo do serviço contratado (spec 013, bloco C). `code` é o MESMO vocabulário de '
  'workers.profession e patients.service_type[] (AT, CAREGIVER, NURSE, KINESIOLOGIST, '
  'PSYCHOLOGIST) — nasce em tabela, não CHECK, para ser FK de patient_contracted_services e '
  'editável sem deploy, molde 307/311.';

COMMENT ON TABLE service_type_aliases IS
  'ConceptMap rótulo da origem → service_types.code. Reusa o vocabulário de '
  'ClickUpPatientMapper/serviceMap.ts (campo "Servicio"). Separado do catálogo pelo mesmo motivo '
  'da 307 (many→one, e PK própria evita colisão silenciosa).';

-- Os 5 códigos, na mesma ordem/rótulo de Profession. sort_order deliberado (sem DEFAULT), como 307.
INSERT INTO service_types (code, sort_order) VALUES
  ('AT', 1), ('CAREGIVER', 2), ('NURSE', 3), ('KINESIOLOGIST', 4), ('PSYCHOLOGIST', 5)
ON CONFLICT (code) DO NOTHING;

-- Aliases medidos em serviceMap.ts (CLICKUP_TO_SERVICE_TYPES) — só os 3 que o ClickUp usa hoje.
-- NURSE/KINESIOLOGIST entram no catálogo (vocabulário fechado de Profession) sem alias: o
-- ClickUp não tem rótulo mapeado para eles ainda (medido, 03/09).
INSERT INTO service_type_aliases (source, label, code) VALUES
  ('clickup', 'Acompañante Terapéutico', 'AT'),
  ('clickup', 'Cuidador (a)',            'CAREGIVER'),
  ('clickup', 'Psicólogo (a)',           'PSYCHOLOGIST')
ON CONFLICT (source, label) DO NOTHING;
