-- 287 — `Tipo de Dispositivo`: catálogo em INGLÊS + relação múltipla por paciente
--
-- ── A decisão, e de quem é ──────────────────────────────────────────────────
-- Gabriel, 25/08, sobre onde mora o valor canônico múltiplo:
--   *"É interessante ser uma tabela nova, pois podemos referenciar o valor como FK em outras
--    tabelas, além de ter um controle futuramente para adicionar ou remover Tipos de
--    dispositivo. Como TODO Enum no sistema, ele precisa ser um ENUM em INGLÊS e quem traduz
--    ele é o frontend."*
--
-- Duas consequências que mudam o desenho em relação à 285 (cobertura):
--   1. **Catálogo é TABELA, não CHECK.** Um `CHECK` não é referenciável por FK e exige migration
--      para cada valor novo. Uma tabela dá as duas coisas que ele pediu: FK a partir de outras
--      tabelas e adicionar/remover tipo sem deploy.
--   2. **O valor canônico é ENUM EM INGLÊS.** O rótulo em espanhol do ClickUp NÃO entra aqui —
--      ele continua no cru (`patient_source_labels`), que existe para reversibilidade. Quem
--      traduz para a tela é o frontend. É a mesma regra de `clinical_specialty` (ASD,
--      NEUROLOGICAL…) e de `serviceMap` (AT, CAREGIVER…).
--
-- ── Por que não tem `ordinal`, diferente da 285 ─────────────────────────────
-- Cobertura tem ordem (1º, 2º) porque a origem manda uma lista ordenada e o 1º alimenta o
-- escalar. Dispositivo é um CONJUNTO: um paciente tem `HOME` e `SCHOOL`, sem que um seja o
-- primeiro. A PK `(patient_id, device_type)` já garante unicidade — não há como duplicar, e não
-- há posição para reordenar errado. Menos estrutura, menos coisa para divergir.
--
-- ── Teto ────────────────────────────────────────────────────────────────────
-- Não há teto aqui, e é deliberado: a FK para `device_types` já limita ao catálogo, e um
-- paciente não pode ter mais tipos do que tipos existem. É o mesmo raciocínio da migration 286
-- (teto = cardinalidade do catálogo ⇒ truncar é impossível), obtido de graça pela FK.
--
-- Rollback: `DROP TABLE patient_device_types; DROP TABLE device_types;` — as duas nascem vazias
-- e o backfill que as preenche marca `source`. `patients.device_type` (escalar) não é tocada.

CREATE TABLE IF NOT EXISTS device_types (
  -- O ENUM, em inglês. É esta coluna que outras tabelas referenciam por FK.
  code        TEXT        PRIMARY KEY,
  -- Permite aposentar um tipo sem apagar histórico: paciente antigo continua apontando para ele.
  -- ⚠️ `active` filtra ENTRADA de dado, nunca leitura do que já existe — é o que a terminologia
  -- clínica prescreve (HL7 FHIR CodeSystem: código inativo segue válido para dado existente e
  -- sai apenas do ValueSet de entrada). Bloquear inativo no INSERT quebraria backfill histórico.
  active      BOOLEAN     NOT NULL DEFAULT true,
  -- A "deprecation date" do FHIR: `active=false` diz O QUÊ, `retired_at` diz DESDE QUANDO.
  retired_at  TIMESTAMPTZ NULL,
  -- ⚠️ Sem DEFAULT 0: com default, todo tipo criado pelo painel nasceria empatado com os outros
  -- novos, e `ORDER BY sort_order` viraria não-determinístico entre requests. Quem cria escolhe
  -- a posição. O desempate final é sempre `, code` — ver o COMMENT de `patients.device_type`.
  sort_order  SMALLINT    NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT device_types_code_upper
    CHECK (code = upper(code) AND code ~ '^[A-Z][A-Z0-9_]*$'),
  CONSTRAINT device_types_sort_order_unico
    UNIQUE (sort_order),
  -- Coerência entre as duas colunas de aposentadoria: uma não pode contradizer a outra.
  CONSTRAINT device_types_retired_coerente
    CHECK ((active AND retired_at IS NULL) OR (NOT active AND retired_at IS NOT NULL))
);

-- ── O mapeamento origem → enum, SEPARADO do catálogo ────────────────────────
-- A 1ª versão punha `source_label TEXT NOT NULL` dentro de `device_types`. Três defeitos:
--   1. **É many→one, e a coluna era one→one.** Já sabemos que acontece: `clinicalSpecialtyMap`
--      colapsa 14 opções do ClickUp em 9 valores (F32). No dia em que a operação criar
--      "Domiciliario Nocturno" e quiser que caia em HOME, uma coluna não guarda dois rótulos.
--   2. **Sem `UNIQUE`, era chave de join que duplica em silêncio.** A migration 288 faz
--      `UPDATE ... WHERE p.device_type = d.source_label`; com dois matches, `UPDATE ... FROM`
--      escolhe um **arbitrariamente**, e isso não é erro em Postgres.
--   3. **Contradizia a tabela irmã:** `patient_device_types.source DEFAULT 'clickup'` declara
--      que haverá mais de uma origem; `source_label` declarava que há exatamente uma.
-- É a separação que a terminologia clínica padroniza: CodeSystem (que códigos existem) ×
-- ConceptMap (como códigos de uma origem mapeiam para os nossos). HL7 FHIR R4.
CREATE TABLE IF NOT EXISTS device_type_aliases (
  source TEXT NOT NULL DEFAULT 'clickup',
  label  TEXT NOT NULL,
  code   TEXT NOT NULL REFERENCES device_types(code) ON UPDATE CASCADE,
  -- A PK garante o que a 288 precisa: um rótulo mapeia para EXATAMENTE um código.
  -- E permite N rótulos por código, que é o que a operação vai precisar.
  CONSTRAINT device_type_aliases_pkey PRIMARY KEY (source, label),
  CONSTRAINT device_type_aliases_label_not_blank CHECK (btrim(label) <> '')
);

CREATE INDEX IF NOT EXISTS idx_device_type_aliases_code
  ON device_type_aliases (code);

COMMENT ON TABLE device_types IS
  'Catálogo de tipos de dispositivo. `code` é o ENUM canônico em INGLÊS e é o que outras '
  'tabelas referenciam por FK; a tradução para a tela é do frontend. O mapeamento a partir dos '
  'rótulos da origem vive em `device_type_aliases` (many→one), NÃO aqui. Decisão do Gabriel, '
  '25/08. ⚠️ Este é o PRIMEIRO `TEXT PRIMARY KEY` do repo (havia 63 `CHECK (... IN (...))`): a '
  'regra é catálogo com FK quando o valor precisa ser referenciado ou editado sem deploy; '
  'CHECK quando é lista fechada de domínio.';

COMMENT ON TABLE device_type_aliases IS
  'ConceptMap: rótulo da origem → `device_types.code`. Separado do catálogo porque o mapeamento '
  'é many→one e porque a PK (source, label) é o que garante que a tradução da migration 288 não '
  'case com dois códigos em silêncio.';


-- Os 5 do catálogo vivo, medidos em 25/08 contra `/list/901304883903/field`.
-- `ON CONFLICT DO NOTHING`: re-rodar a migration não sobrescreve `active`/`sort_order` que
-- alguém tenha ajustado depois — o catálogo é dado de operação a partir daqui, não de deploy.
INSERT INTO device_types (code, sort_order) VALUES
  ('HOME', 1), ('SCHOOL', 2), ('INSTITUTIONAL', 3), ('INPATIENT', 4), ('TRANSPORT', 5)
ON CONFLICT (code) DO NOTHING;

INSERT INTO device_type_aliases (source, label, code) VALUES
  ('clickup', 'Domiciliario',  'HOME'),
  ('clickup', 'Escolar',       'SCHOOL'),
  ('clickup', 'Institucional', 'INSTITUTIONAL'),
  ('clickup', 'Internación',   'INPATIENT'),
  ('clickup', 'Traslado',      'TRANSPORT')
ON CONFLICT (source, label) DO NOTHING;

CREATE TABLE IF NOT EXISTS patient_device_types (
  patient_id   UUID        NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  -- ⚠️ `ON UPDATE CASCADE`: com chave natural, renomear um code SEM isso fica BLOQUEADO pela
  -- FK (o default é NO ACTION) e vira migration com downtime. Com isso, é um UPDATE.
  -- Medido: `ON UPDATE CASCADE` aparece 0 vezes nas 189 migrations anteriores — é convenção
  -- nova, e ela existe porque a chave aqui é natural, não surrogate.
  device_type  TEXT        NOT NULL REFERENCES device_types(code) ON UPDATE CASCADE,
  source       TEXT        NOT NULL DEFAULT 'clickup',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Conjunto, não lista: a PK já impede duplicata e não há ordem a errar.
  CONSTRAINT patient_device_types_pkey PRIMARY KEY (patient_id, device_type)
);

-- ⚠️ Índice COMPOSTO, não de coluna única. Com 5 valores distintos cada um cobre ~20% das
-- linhas, e a essa seletividade o planner IGNORA um índice de coluna única — ele acha os TIDs
-- e ainda vai ao heap buscar `patient_id`. Com `(device_type, patient_id)`,
-- `SELECT patient_id ... WHERE device_type = 'INPATIENT'` vira **index-only scan**: não toca o
-- heap, sem random I/O. Serve também à checagem de integridade referencial quando alguém
-- alterar `device_types` — o Postgres NÃO cria índice automático no lado referenciante da FK.
CREATE INDEX IF NOT EXISTS idx_patient_device_types_type
  ON patient_device_types (device_type, patient_id);

COMMENT ON TABLE patient_device_types IS
  'Tipos de dispositivo de um paciente, MÚLTIPLO (Fase 4 de campos-admissao). Satélite de '
  '`patients` para o ABAC F1: jurisdição derivada da FK obrigatória, sem coluna `country` '
  'própria (C-A′ do parecer lex). Retenção: enquanto a tarefa existir no ClickUp; supressão '
  'junto do soft delete. ⚠️ INPATIENT e INSTITUTIONAL revelam regime de cuidado — dado de saúde.';

COMMENT ON COLUMN patient_device_types.created_at IS
  'Não há `updated_at`, diferente das tabelas irmãs, e é deliberado: o padrão de escrita é '
  'DELETE+INSERT do conjunto inteiro, então `updated_at` seria sempre igual a `created_at`.';
