-- 311 — `Cobertura Verificada`: catálogo em CÓDIGO + ConceptMap (spec 012, US-B3)
--
-- Molde EXATO da 307 (`device_types` + `device_type_aliases`): catálogo é TABELA (referenciável
-- por FK, editável sem deploy — decisão do Gabriel, 25/08), e o mapeamento rótulo→código vive
-- SEPARADO, many→one, com PK (source, label) para que um rótulo case com EXATAMENTE um código.
--
-- ── O que muda em relação à 305 ─────────────────────────────────────────────
-- A 305 gravou o rótulo CRU (`patient_insurance_verified.raw_label`) porque o catálogo vivo tem
-- 33 opções e "muda sem migration". Continua verdade — e é exatamente por isso que o catálogo é
-- uma tabela e não um CHECK. O cru fica (reversibilidade); o CÓDIGO nasce ao lado (312).
--
-- ── Os 33 códigos ───────────────────────────────────────────────────────────
-- Medidos no catálogo VIVO em 03/09/2026 (`GET /list/901304883903/field`, campo
-- `4876ef2c-c96e-4983-95b7-83ab9e2b7676`, 33 opções) — contrato em
-- `specs/001-campos-admissao/contracts/clickup-fields.md` §Enums canônicos. São NOMES PRÓPRIOS:
-- o "inglês" aqui é código, não tradução — só `Privado → PRIVATE` e `Otra → OTHER` traduzem.
--
-- ⚠️ lex C3.1 (03/09): parte das obras sociales é SINDICAL (`SANIDAD` = OSPSA/FATSA) — o código
-- revela afiliação sindical, categoria sensível autônoma (Ley 25.326 art. 2). O catálogo em si
-- não tem dado pessoal; o que gruda no paciente (`patient_insurance_verified`) já está REVOGADO
-- do `enlite_mcp_ro` (create-mcp-ro-role.sql), e a coluna nova da 312 herda a revogação.
--
-- Rollback: `DROP TABLE insurance_provider_aliases; DROP TABLE insurance_providers;` — nascem
-- do seed; a 312 tem de ser revertida antes (FK).

CREATE TABLE IF NOT EXISTS insurance_providers (
  code        TEXT        PRIMARY KEY,
  active      BOOLEAN     NOT NULL DEFAULT true,
  retired_at  TIMESTAMPTZ NULL,
  -- Sem DEFAULT 0 (mesma razão da 307): quem cria escolhe a posição; o desempate é `, code`.
  sort_order  SMALLINT    NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT insurance_providers_code_upper
    CHECK (code = upper(code) AND code ~ '^[A-Z][A-Z0-9_]*$'),
  CONSTRAINT insurance_providers_sort_order_unico
    UNIQUE (sort_order),
  CONSTRAINT insurance_providers_retired_coerente
    CHECK ((active AND retired_at IS NULL) OR (NOT active AND retired_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS insurance_provider_aliases (
  source TEXT NOT NULL DEFAULT 'clickup',
  label  TEXT NOT NULL,
  code   TEXT NOT NULL REFERENCES insurance_providers(code) ON UPDATE CASCADE,
  CONSTRAINT insurance_provider_aliases_pkey PRIMARY KEY (source, label),
  CONSTRAINT insurance_provider_aliases_label_not_blank CHECK (btrim(label) <> '')
);

CREATE INDEX IF NOT EXISTS idx_insurance_provider_aliases_code
  ON insurance_provider_aliases (code);

COMMENT ON TABLE insurance_providers IS
  'Catálogo de coberturas (obras sociales / prepagas). `code` é o ENUM canônico e é o que '
  '`patient_insurance_verified.provider_code` referencia por FK (migration 312); a tradução '
  'para a tela é do frontend. Editável pelo endpoint admin `POST /api/admin/catalogs/'
  'insurance-providers` — sem deploy. Molde: `device_types` (307). Spec 012, US-B3.';

COMMENT ON TABLE insurance_provider_aliases IS
  'ConceptMap: rótulo da origem (ClickUp, 33 opções vivas em 03/09/2026) → `insurance_providers.code`. '
  'A PK (source, label) garante que um rótulo case com UM código — o backfill da 312 depende disso.';

-- Os 33 do catálogo vivo, na ordem em que o ClickUp os lista (contrato 001).
-- `ON CONFLICT DO NOTHING`: re-rodar não sobrescreve `active`/`sort_order` ajustados depois.
INSERT INTO insurance_providers (code, sort_order) VALUES
  ('API', 1), ('ACCORD_SALUD', 2), ('ASISOC', 3), ('AVALIAN', 4), ('BANCARIOS', 5), ('CASA', 6),
  ('DAS', 7), ('GALENO', 8), ('MHM', 9), ('MEDICUS', 10), ('HTAL_BRITANICO', 11), ('OSPJN', 12),
  ('OSPECOM', 13), ('OSMECON', 14), ('OSDE', 15), ('OMINT', 16), ('OSPOCE', 17), ('OGORMAN', 18),
  ('OSPATCA', 19), ('OBSBA', 20), ('OSPELSYM', 21), ('OSTEE_LUZ_MEDICA', 22), ('OSDEPYM', 23),
  ('OTHER', 24), ('PFA_SUPERINTENDENCIA', 25), ('PRIVATE', 26), ('SANIDAD', 27), ('SWISS_MEDICAL', 28),
  ('UP', 29), ('OSPICHA', 30), ('USUOMRA', 31), ('PREVENCION_SALUD', 32), ('IOSCOR', 33)
ON CONFLICT (code) DO NOTHING;

-- Rótulo LITERAL do ClickUp (inclusive o acento agudo em `O´Gorman`, que é U+00B4 na origem).
INSERT INTO insurance_provider_aliases (source, label, code) VALUES
  ('clickup', 'API',                                'API'),
  ('clickup', 'Accord Salud',                       'ACCORD_SALUD'),
  ('clickup', 'ASISOC',                             'ASISOC'),
  ('clickup', 'Avalian',                            'AVALIAN'),
  ('clickup', 'Bancarios',                          'BANCARIOS'),
  ('clickup', 'CASA',                               'CASA'),
  ('clickup', 'DAS',                                'DAS'),
  ('clickup', 'Galeno',                             'GALENO'),
  ('clickup', 'MHM',                                'MHM'),
  ('clickup', 'Medicus',                            'MEDICUS'),
  ('clickup', 'Htal Británico',                     'HTAL_BRITANICO'),
  ('clickup', 'OSPJN',                              'OSPJN'),
  ('clickup', 'OSPECOM',                            'OSPECOM'),
  ('clickup', 'OSMECON',                            'OSMECON'),
  ('clickup', 'OSDE',                               'OSDE'),
  ('clickup', 'Omint',                              'OMINT'),
  ('clickup', 'OSPOCE',                             'OSPOCE'),
  ('clickup', 'O´Gorman',                           'OGORMAN'),
  ('clickup', 'OSPATCA',                            'OSPATCA'),
  ('clickup', 'ObSBA',                              'OBSBA'),
  ('clickup', 'Ospelsym',                           'OSPELSYM'),
  ('clickup', 'Ostee Luz Médica',                   'OSTEE_LUZ_MEDICA'),
  ('clickup', 'Osdepym',                            'OSDEPYM'),
  ('clickup', 'Otra',                               'OTHER'),
  ('clickup', 'PFA Superintendencia de Bienestar',  'PFA_SUPERINTENDENCIA'),
  ('clickup', 'Privado',                            'PRIVATE'),
  ('clickup', 'SANIDAD',                            'SANIDAD'),
  ('clickup', 'Swiss Medical',                      'SWISS_MEDICAL'),
  ('clickup', 'UP',                                 'UP'),
  ('clickup', 'OSPICHA',                            'OSPICHA'),
  ('clickup', 'USUOMRA',                            'USUOMRA'),
  ('clickup', 'Prevención Salud',                   'PREVENCION_SALUD'),
  ('clickup', 'IOSCOR',                             'IOSCOR')
ON CONFLICT (source, label) DO NOTHING;
