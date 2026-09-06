-- 325 — `patient_diagnoses`: o diagnóstico ESTRUTURADO do paciente (spec 016, F2; D263 —
-- "Desenho da F2 do CID-11", 04/09/2026: 3 dos 4 desvios do CTO aceitos, 1 rejeitado com medição)
--
-- ── Por que os nomes de coluna são NEUTROS de vocabulário (`concept_*`, não `icd_*`) ─────────
-- Aceito do parecer do CTO (D263): `terminology_system` já declara QUAL vocabulário a linha usa
-- ('ICD-11' hoje). Uma coluna chamada `icd_uri` com `terminology_system='SNOMED'` dentro seria
-- autocontradição — e a porta É trocável por decisão (D190/D258, "Contrato de arquitetura" da
-- spec 016). `concept_*` também é o termo do FHIR, no qual `TerminologyPort` já foi modelada
-- (ver domain/TerminologyPort.ts do módulo terminology).
--
-- ── `terminology_system` SEM DEFAULT ────────────────────────────────────────────────────────
-- Mesmo espírito de `country` nas migrations 316/319: campo que decide semântica não pode ter
-- valor "de graça" — todo escritor declara explicitamente qual vocabulário está gravando. Hoje
-- só 'ICD-11' é aceito (CHECK); um segundo vocabulário (SNOMED) exigiria ALTER do CHECK, nunca
-- inferência por omissão.
--
-- ── `concept_code` é TEXT, nunca VARCHAR(n) ─────────────────────────────────────────────────
-- Cluster pós-coordenado do CID-11 (`KA00.0/XS2R&XS5W`) é um código válido e mais longo que
-- qualquer VARCHAR curto que alguém "razoavelmente" escolheria — é exatamente a classe de
-- defeito medida na F0 (`6A02.Z` truncado para `02.Z` na TELA; aqui a garantia é não repetir o
-- truncamento no BANCO). CHECK de comprimento (1..120) é a única fronteira, generosa o
-- suficiente para clusters de várias unidades.
--
-- ── SEM FK para `terminology.icd_entities` (decisão intencional, não esquecimento) ─────────
-- Três motivos, cada um sozinho já bastaria (F1.5/D261, confirmado sem contestação na D263):
--   1. Cluster pós-coordenado (`XX/YY&ZZ`) não tem linha própria no catálogo — é uma COMBINAÇÃO
--      de códigos existentes, montada pela ECT/busca, não uma entidade que o ingestor grava.
--   2. O catálogo pode ser RECARREGADO em bloco (novo release) — uma FK amarraria o diagnóstico
--      do paciente ao ciclo de vida de uma tabela de referência que existe para ser trocada.
--   3. `terminology` e `public` têm posturas de segurança OPOSTAS (schema público-OMS vs.
--      schema PHI deny-by-default) — uma FK cruzando esse limite acopla dois modelos de acesso
--      que devem poder evoluir independentes.
-- A integridade vem da VALIDAÇÃO NA ESCRITA: o caso de uso (RecordPatientDiagnosis) chama
-- `TerminologyPort.getByUri(conceptUri)` e só grava o que a porta resolveu — 422 se não resolver
-- (molde do 422 de DeviceTypeUnknownError, migration 319/AdminPatientContractedServicesController).
--
-- ── Dedupe por `concept_code`, NUNCA por `concept_uri` ──────────────────────────────────────
-- Dois clusters pós-coordenados distintos (`KA00.0/XS2R` e `KA00.0/XS5W`) podem compartilhar a
-- URI do STEM (a base sem a extensão) — são fatos clínicos DIFERENTES. Chavear o índice único
-- por `concept_uri` apagaria um em silêncio (23505 no segundo INSERT, ou pior, um upsert que
-- sobrescreve). `concept_code` carrega o cluster INTEIRO (IcdCode não trunca — F0/D7), então é
-- ele, não a URI, que identifica a linha.
--
-- ── `is_primary` único por `(patient_id, source)`, não por paciente inteiro ─────────────────
-- REGRA-03 (Diego, `2026-08-12a`): "o dado nasce no Postgres e vai para fora, nunca de fora para
-- dentro". O painel (`PANEL`) e o ClickUp (`CLICKUP`) podem ter, cada um, SEU principal — o
-- espelho do ClickUp (F4) nunca pode desativar ou despromover o principal que o painel gravou
-- (é o teste 2 da F2: "o espelho não desativa o diagnóstico do painel"). "Qual dos dois vence na
-- TELA" é regra de APRESENTAÇÃO (PrimaryDiagnosisPolicy, domain/), não de armazenamento.
--
-- ── `source` ganha `'BACKFILL'` desde já (D263, aceito) ─────────────────────────────────────
-- Sem um valor próprio não há como CONTAR nem DESFAZER o que o backfill dos 323 pacientes com
-- `diagnosis` texto livre vai escrever na F4 (D260: "se você conseguir sim"). Uma palavra hoje;
-- o índice único por `(patient_id, source)` já funciona para BACKFILL como para os outros dois.
--
-- ── Baixa é `active=false` + `ended_at`, NUNCA DELETE (mesmo molde 307/319) ─────────────────
-- Sem rota DELETE (ver AdminPatientDiagnosesController). CHECK `pd_active_ended_coerente` барra
-- o par incoerente; CHECK `pd_primary_so_se_ativo` barra "principal E inativo" ao mesmo tempo —
-- a única forma de deixar de ser principal é o SetPrimaryDiagnosis promover outro (rebaixando
-- este) ou desativar (que já implica NOT is_primary, pelo mesmo CHECK).
--
-- ── `concept_language` (D258, F1 §identidade) ───────────────────────────────────────────────
-- O release 2026-01 tem buracos de tradução (medido na F0): título ausente em espanhol cai para
-- inglês. Sem esta coluna, ninguém consegue saber DEPOIS se o título gravado na linha do
-- paciente foi o pedido ('es') ou o fallback ('en') — vira suposição, não fato auditável.
--
-- ── `catalog_release` NA LINHA (Contrato de arquitetura, "o que fica encapsulado") ─────────
-- "Migration grava release e language NA LINHA — diagnóstico gravado em 2026-01 continua
-- legível quando o release virar 2027-01." Sem isto, "trocar fácil" seria mentira: o dado velho
-- ficaria órfão. Gravado pelo caso de uso a partir de `DiagnosisEntity.release` (o que a porta
-- devolveu), nunca hardcoded aqui.
--
-- ── `country` por TRIGGER (molde 316/319) ───────────────────────────────────────────────────
-- Mesma razão das duas migrations anteriores: `country` NOT NULL sem DEFAULT — a RLS da F1 do
-- ABAC (ainda não ligada) vai precisar dela, e um DEFAULT esconderia um escritor que esqueceu de
-- informar o país (a pegadinha medida no F0 do ABAC: 8 tabelas com `DEFAULT 'AR'`).
--
-- ── `created_by`/`updated_by` NOT NULL (molde 319) ──────────────────────────────────────────
-- Todo caminho de escrita hoje é autenticado: o painel admin (staff) ou o sync do ClickUp
-- (ator de sistema nomeado) — não há caminho anônimo. Exigir o uid na mesma transação é reforço.
--
-- ── GRANT ao `enlite_mcp_ro` — REVOKE no MESMO commit (D263, "o mais urgente") ──────────────
-- `scripts/create-mcp-ro-role.sql:87` (`GRANT SELECT ON ALL TABLES IN SCHEMA public`) faz TODA
-- tabela nova de `public` nascer legível pelo conector claude.ai. `patient_diagnoses` não tem
-- coluna segura — `concept_group='06'` sozinho já revela saúde mental (capítulo 06 do CID-11).
-- Revogação da TABELA INTEIRA (não por coluna: não há coluna segura), feita no mesmo commit
-- desta migration, no script `create-mcp-ro-role.sql` — nunca depois, nunca "na próxima PR".
--
-- Rollback: DROP TABLE patient_diagnoses; — nasce vazia nesta árvore, nenhum dado de produção
-- depende dela ainda (F2 é a primeira fase que cria esta tabela).

CREATE TABLE IF NOT EXISTS patient_diagnoses (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id          UUID        NOT NULL REFERENCES patients(id) ON DELETE CASCADE,

  -- Qual vocabulário — sem DEFAULT (ver nota acima). Hoje só 'ICD-11'.
  terminology_system  TEXT        NOT NULL,
  concept_uri         TEXT        NOT NULL,
  -- TEXT, nunca VARCHAR(n): cluster pós-coordenado é código válido (ver nota acima).
  concept_code        TEXT        NOT NULL,
  concept_title       TEXT        NOT NULL,
  -- 'es' | 'en' — qual idioma o título gravado REALMENTE é (pedido ou fallback, ver nota acima).
  concept_language    TEXT        NOT NULL,
  -- Capítulo da OMS. Nome NEUTRO de propósito: capítulo NÃO determina segmento terapêutico
  -- (suspensão declarada da D164 — ver "Suposições" da spec.md, D261). NÃO confundir com
  -- `patients.clinical_segments` (migration 037), que é OUTRA coisa e não é assunto desta fase.
  concept_group       TEXT        NOT NULL,
  -- Release do catálogo em que este conceito foi resolvido — grava NA LINHA (Contrato de
  -- arquitetura): diagnóstico gravado em 2026-01 continua legível quando o release virar 2027-01.
  catalog_release     TEXT        NOT NULL,

  -- Origem de ESCRITA (não confundir com terminology_system, que é o VOCABULÁRIO). Ordem de
  -- precedência (PANEL > CLICKUP > BACKFILL) vive em domain/DiagnosisSource.ts, não aqui.
  source              TEXT        NOT NULL,
  is_primary          BOOLEAN     NOT NULL DEFAULT false,
  active              BOOLEAN     NOT NULL DEFAULT true,
  ended_at            TIMESTAMPTZ NULL,

  country             TEXT        NULL,  -- NOT NULL aplicada no fim, depois do trigger (molde 316/319)
  created_by          VARCHAR(128) NOT NULL,
  updated_by          VARCHAR(128) NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT pd_terminology_system_check
    CHECK (terminology_system IN ('ICD-11')),
  CONSTRAINT pd_source_check
    CHECK (source IN ('PANEL', 'CLICKUP', 'BACKFILL')),
  CONSTRAINT pd_concept_language_check
    CHECK (concept_language IN ('es', 'en')),
  CONSTRAINT pd_concept_code_len
    CHECK (length(concept_code) BETWEEN 1 AND 120),
  CONSTRAINT pd_concept_uri_nao_vazio
    CHECK (btrim(concept_uri) <> ''),
  CONSTRAINT pd_concept_title_nao_vazio
    CHECK (btrim(concept_title) <> ''),
  CONSTRAINT pd_concept_group_nao_vazio
    CHECK (btrim(concept_group) <> ''),
  CONSTRAINT pd_catalog_release_nao_vazio
    CHECK (btrim(catalog_release) <> ''),
  -- Molde 307/319: as duas colunas de baixa não podem se contradizer.
  CONSTRAINT pd_active_ended_coerente
    CHECK ((active AND ended_at IS NULL) OR (NOT active AND ended_at IS NOT NULL)),
  -- Um diagnóstico inativo não pode continuar marcado como principal — a única forma de deixar
  -- de ser principal é SetPrimaryDiagnosis promover outro (rebaixa este) OU desativar.
  CONSTRAINT pd_primary_so_se_ativo
    CHECK (NOT is_primary OR active)
);

-- No máximo UM principal por (paciente, origem) — REGRA-03 (Diego): o painel e o ClickUp têm,
-- cada um, seu próprio principal; nunca um índice por paciente inteiro (ver nota acima).
CREATE UNIQUE INDEX IF NOT EXISTS uq_patient_diagnoses_primary_por_origem
  ON patient_diagnoses (patient_id, source)
  WHERE is_primary AND active;

-- Dedupe por CÓDIGO (cluster inteiro), NUNCA por URI — ver nota acima. Dois clusters que
-- compartilham o stem da URI são fatos clínicos diferentes e precisam conviver.
CREATE UNIQUE INDEX IF NOT EXISTS uq_patient_diagnoses_codigo_ativo_por_origem
  ON patient_diagnoses (patient_id, source, concept_code)
  WHERE active;

CREATE INDEX IF NOT EXISTS idx_patient_diagnoses_patient_active
  ON patient_diagnoses (patient_id, active);
CREATE INDEX IF NOT EXISTS idx_patient_diagnoses_country
  ON patient_diagnoses (country);

CREATE OR REPLACE FUNCTION fn_patient_diagnoses_country_from_patient()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.country IS NULL THEN
    SELECT p.country INTO NEW.country FROM patients p WHERE p.id = NEW.patient_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_patient_diagnoses_country ON patient_diagnoses;
CREATE TRIGGER trg_patient_diagnoses_country
  BEFORE INSERT ON patient_diagnoses
  FOR EACH ROW EXECUTE FUNCTION fn_patient_diagnoses_country_from_patient();

ALTER TABLE patient_diagnoses ALTER COLUMN country SET NOT NULL;

ALTER TABLE patient_diagnoses DROP CONSTRAINT IF EXISTS pd_country_check;
ALTER TABLE patient_diagnoses
  ADD CONSTRAINT pd_country_check CHECK (country IN ('AR', 'BR'));

COMMENT ON TABLE patient_diagnoses IS
  'Diagnóstico ESTRUTURADO do paciente por terminologia clínica (spec 016 F2; D263, 04/09/2026). '
  'Nomes de coluna NEUTROS de vocabulário (concept_*, não icd_*): terminology_system declara QUAL '
  'vocabulário — hoje só ICD-11. SEM FK para terminology.icd_entities (D261/D263, decisão '
  'intencional): cluster pós-coordenado não tem linha própria, o catálogo é recarregável em '
  'bloco, e os dois schemas têm posturas de segurança opostas — a integridade vem da validação '
  'NA ESCRITA (RecordPatientDiagnosis chama TerminologyPort.getByUri, 422 se não resolver). '
  'Dedupe por concept_code (o CLUSTER inteiro), nunca por concept_uri — dois clusters podem '
  'compartilhar a URI do stem e são fatos clínicos diferentes. is_primary é único por '
  '(patient_id, source) — REGRA-03 (Diego): painel e ClickUp têm cada um seu principal; qual '
  'vence na TELA é PrimaryDiagnosisPolicy (domain/), não armazenamento. Baixa = active=false + '
  'ended_at, nunca DELETE. Dado tocado: sensível-saúde — SEM coluna segura para o enlite_mcp_ro '
  '(concept_group=''06'' já revela saúde mental); REVOKE da tabela inteira no mesmo commit, em '
  'scripts/create-mcp-ro-role.sql.';
COMMENT ON COLUMN patient_diagnoses.terminology_system IS
  'Vocabulário da linha (hoje só ICD-11, CHECK). SEM DEFAULT: todo escritor declara '
  'explicitamente — evita base com dois vocabulários indistinguível por omissão (D190).';
COMMENT ON COLUMN patient_diagnoses.concept_code IS
  'TEXT, nunca VARCHAR(n): cluster pós-coordenado (KA00.0/XS2R&XS5W) é código válido e mais '
  'longo que qualquer teto curto. CHECK de comprimento 1..120 é a única fronteira. Chave do '
  'dedupe (não concept_uri — ver COMMENT da tabela).';
COMMENT ON COLUMN patient_diagnoses.concept_language IS
  'es|en — qual idioma o título GRAVADO realmente é (pedido ou fallback): o release 2026-01 tem '
  'buracos de tradução em espanhol (medido F0). Sem esta coluna não dá pra saber depois.';
COMMENT ON COLUMN patient_diagnoses.catalog_release IS
  'Release do catálogo em que o conceito foi resolvido, gravado NA LINHA (Contrato de '
  'arquitetura da spec 016): diagnóstico de 2026-01 continua legível quando o release mudar.';
COMMENT ON COLUMN patient_diagnoses.concept_group IS
  'Capítulo da OMS. Nome NEUTRO de propósito: NÃO determina segmento terapêutico (suspensão '
  'declarada da D164, D261) — não confundir com patients.clinical_segments (migration 037).';
COMMENT ON COLUMN patient_diagnoses.source IS
  'Origem de ESCRITA — PANEL|CLICKUP|BACKFILL (D263: BACKFILL entra já nesta fase para poder '
  'contar/desfazer o backfill da F4). Ordem de precedência de EXIBIÇÃO vive em '
  'domain/DiagnosisSource.ts, não é uma coluna.';
COMMENT ON COLUMN patient_diagnoses.country IS
  'Jurisdição do diagnóstico (AR|BR), NOT NULL sem DEFAULT. Derivada de patients.country por '
  'trigger (molde 316/319).';
