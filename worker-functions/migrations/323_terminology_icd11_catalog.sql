-- 323 — schema `terminology`: catálogo CID-11 (spec 016, F1; decisões D257/D259/D260)
--
-- ── Por que um SCHEMA, não uma tabela em `public` (D259, Gabriel 03/09) ─────
-- "Schema separado já é uma boa." Namespace próprio, grants próprios, recarga em bloco (o
-- ingestor pode fazer TRUNCATE/reload de um release sem encostar em tabela clínica), e
-- fronteira explícita de "isto NÃO é PHI" — o oposto do resto do banco, onde a regra é
-- deny-by-default por coluna (create-mcp-ro-role.sql). ⚠️ MEDIDO: é o PRIMEIRO `CREATE SCHEMA`
-- de aplicação do repo — as 299 migrations anteriores só tocam `public` (+ `tiger`/`topology`
-- do PostGIS). Não há nenhum outro precedente de schema de app para copiar.
--
-- ── O que este catálogo NÃO é ───────────────────────────────────────────────
-- Não guarda diagnóstico de paciente (isso é a F2, `patient_diagnoses`, com FK textual para
-- `icd_uri` — sem JOIN atravessando a fronteira, a linha do paciente desnormaliza código/título/
-- release). É só o dado de referência da OMS: 35.692 códigos do release 2026-01, ~1,5 MB.
--
-- ── `icd_releases` — promoção de release é ATO DELIBERADO (spec: "nunca automático") ────────
-- O ingestor faz upsert aqui a cada rodada (ingested_at, entity_count), mas `is_current` só
-- muda por um comando separado (`--promote`). Índice único parcial garante NO MÁXIMO um release
-- corrente ao mesmo tempo — dois `is_current=true` simultâneos deixariam "qual é o vigente?"
-- ambíguo para todo leitor futuro.
--
-- ── `icd_entities` ───────────────────────────────────────────────────────────
-- `icd_uri` é a URI CANÔNICA da OMS (`http://id.who.int/icd/release/11/.../mms/<id>`), guardada
-- como IDENTIFICADOR — cláusula 1.2.2 da licença EXIGE guardar a URI junto do código. É
-- identificador, nunca endereço para buscar: nenhum código de produção (adaptador incluído) faz
-- HTTP contra ela — só o ingestor (fora de produção) resolve endereço, e SEMPRE reescrevendo o
-- host para o container local antes de qualquer request (ver `scripts/ingest-icd11-catalog.ts`;
-- o teste que prova isso está no adaptador: `IcdCatalogTerminology` nunca chama `fetch`/`http`).
-- `title_es`/`title_en` são NULLABLE porque o release 2026-01 tem buracos de tradução em
-- espanhol (medido na F0) — NUNCA preenchidos por tradução nossa (cláusula 1.2.3: não traduzimos
-- título de diagnóstico). `chapter` é o código do capítulo-raiz (ex.: '06'), gravado pelo
-- ingestor durante o crawl (a API não devolve esse campo no GET de entidade solta — só no
-- `/search`), não por JOIN. `kind`: 'chapter' (28 raízes + V/X) | 'stem' (diagnóstico normal) |
-- 'extension' (os 17.160 códigos do capítulo X — NÃO são diagnóstico; ingeridos e marcados, mas
-- fora da busca padrão — `search()` do adaptador filtra `kind <> 'extension'` por default).
-- `parent_uri` é solto (sem FK): blocos (`classKind='block'`) não têm `code` e por isso NÃO são
-- gravados aqui (é o motivo da contagem bater exatamente com "entidades COM código" da F0/F1) —
-- um `parent_uri` pode legitimamente apontar para uma URI que não existe nesta tabela. Ver
-- `ancestorsOf` no adaptador: `block` no retorno fica `undefined` por esse motivo (documentado
-- como limite conhecido da F1, não como bug).
--
-- ── `icd_synonyms` — é NOSSA, não da OMS (cláusula 1.2.4) ───────────────────
-- Ver COMMENT ON TABLE abaixo — tem de dizer isso explicitamente no schema, não só em doc.
-- Nasce VAZIA: a busca tolerante a erro da F1 (US-1) é entregue pelo `pg_trgm` sobre os títulos
-- da própria OMS (medido: `word_similarity('esquisofrenia', 'Esquizofrenia...')` = 0,65,
-- acima do piso 0,3). Esta tabela existe para quando a operação achar um buraco que o trigram
-- não cobre (gíria, sigla local) — aí alguém do time adiciona um termo aqui, marcado como nosso.
--
-- ── Índices `pg_trgm` (GIN) ──────────────────────────────────────────────────
-- Sobre `title_es`/`title_en` — são o que dá busca tolerante a erro de graça (`pg_trgm` e
-- `fuzzystrmatch` já estavam instalados, medido na F0; nenhuma extensão nova aqui).
--
-- ── GRANT ao `enlite_mcp_ro` — o OPOSTO da regra de `patients` ──────────────
-- Catálogo da OMS é dado PÚBLICO, não PHI. Em `public`, a regra é negar por padrão e o MCP só lê
-- coluna nomeada (create-mcp-ro-role.sql). Aqui é o inverso: schema inteiro legível, porque não
-- há texto clínico de paciente algum nestas 3 tabelas — só nomenclatura da OMS e sinônimos
-- nossos de busca. Guardado atrás de `IF EXISTS (SELECT ... pg_roles)` porque a role nasce de um
-- script separado (`scripts/create-mcp-ro-role.sql`) que pode não ter rodado ainda no ambiente.
--
-- Rollback: REVOKE + DROP TABLE icd_synonyms, icd_entities, icd_releases; DROP SCHEMA terminology;
-- — nasce vazio nesta árvore, nenhum dado de produção depende dele ainda (F1 é catálogo isolado).

CREATE SCHEMA IF NOT EXISTS terminology;

COMMENT ON SCHEMA terminology IS
  'Catálogo de terminologia clínica (CID-11 da OMS). Dado de REFERÊNCIA público, não PHI — '
  'ao contrário de `public`, este schema é legível por padrão pelo enlite_mcp_ro. Primeiro '
  'schema de aplicação do repo (migration 323, spec 016 F1).';

-- ── icd_releases ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS terminology.icd_releases (
  release       TEXT        PRIMARY KEY,
  is_current    BOOLEAN     NOT NULL DEFAULT false,
  entity_count  INT         NOT NULL DEFAULT 0,
  ingested_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  promoted_at   TIMESTAMPTZ NULL,
  promoted_by   TEXT        NULL,

  CONSTRAINT icd_releases_entity_count_nao_negativo CHECK (entity_count >= 0),
  -- Promoção é ato deliberado: as duas colunas de "quando/quem promoveu" só existem juntas
  -- com is_current=true, nunca sozinhas (mesmo molde de `pcs_active_ended_coerente`, mig 319).
  CONSTRAINT icd_releases_promocao_coerente
    CHECK (
      (is_current AND promoted_at IS NOT NULL AND promoted_by IS NOT NULL)
      OR (NOT is_current AND promoted_at IS NULL AND promoted_by IS NULL)
    )
);

-- No máximo UM release corrente ao mesmo tempo.
CREATE UNIQUE INDEX IF NOT EXISTS icd_releases_no_maximo_um_corrente
  ON terminology.icd_releases (is_current)
  WHERE is_current;

COMMENT ON TABLE terminology.icd_releases IS
  'Releases do CID-11 já ingeridos e qual é o CORRENTE. Promover (is_current) é ato deliberado '
  '— o ingestor faz upsert de entity_count/ingested_at a cada rodada, mas nunca liga is_current '
  'sozinho (spec 016: "trocar release é ato deliberado, nunca automático").';

-- ── icd_entities ─────────────────────────────────────────────────────────────
-- 🔧 F1-CORREÇÃO D1 (03/09): identidade da linha passa de `icd_uri` sozinho para o PAR
-- `(icd_uri, release)`. Motivo medido: `icd_uri` embute o release no path
-- (http://id.who.int/icd/release/11/<release>/mms/<id>), então em uso normal já não colide
-- entre releases — mas o schema não pode DEPENDER dessa coincidência de formato para a garantia
-- "dois releases coexistem" (spec 016 F1, "catálogo guarda MAIS DE UM release"). Com PK só em
-- `icd_uri`, um erro operacional (--release declarado != release da URL, D10) faz o upsert
-- SOBRESCREVER a linha do release antigo em vez de gravar uma linha nova — foi assim que
-- `--promote` promoveu um release com 0 linhas de verdade (entity_count mentia 35692). A defesa
-- correta é a chave primária refletir a identidade real do dado, não confiar em nunca errar o
-- CLI (D10 valida a entrada, mas a chave composta é o que torna a colisão IMPOSSÍVEL mesmo se a
-- validação falhar por algum caminho não previsto).
CREATE TABLE IF NOT EXISTS terminology.icd_entities (
  icd_uri     TEXT        NOT NULL,
  release     TEXT        NOT NULL REFERENCES terminology.icd_releases(release) ON UPDATE CASCADE,
  code        TEXT        NOT NULL,
  title_es    TEXT        NULL,
  title_en    TEXT        NULL,
  chapter     TEXT        NOT NULL,
  parent_uri  TEXT        NULL,
  kind        TEXT        NOT NULL,
  is_leaf     BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT icd_entities_pkey PRIMARY KEY (icd_uri, release),
  CONSTRAINT icd_entities_kind_valido CHECK (kind IN ('chapter', 'stem', 'extension')),
  CONSTRAINT icd_entities_code_nao_vazio CHECK (btrim(code) <> ''),
  -- Cláusula 1.2.3: não traduzimos. Mas pelo menos UM idioma tem de vir da própria OMS —
  -- linha sem título nenhum não serve para busca nem para tela.
  CONSTRAINT icd_entities_titulo_presente CHECK (title_es IS NOT NULL OR title_en IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_icd_entities_release ON terminology.icd_entities (release);
CREATE INDEX IF NOT EXISTS idx_icd_entities_chapter ON terminology.icd_entities (chapter);
CREATE INDEX IF NOT EXISTS idx_icd_entities_parent_uri ON terminology.icd_entities (parent_uri);
CREATE INDEX IF NOT EXISTS idx_icd_entities_kind ON terminology.icd_entities (kind);

-- Busca tolerante a erro (US-1) — o que a OMS não entrega (flexisearch medido na F0: 0
-- resultados para "esquisofrenia"). `pg_trgm` já instalado (F0), nenhuma extensão nova.
CREATE INDEX IF NOT EXISTS idx_icd_entities_title_es_trgm
  ON terminology.icd_entities USING GIN (title_es gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_icd_entities_title_en_trgm
  ON terminology.icd_entities USING GIN (title_en gin_trgm_ops);

COMMENT ON TABLE terminology.icd_entities IS
  'Catálogo CID-11 completo (todos os 28 capítulos + V/X, ~35.692 códigos no release 2026-01) — '
  'guardar a classificação INTEIRA é decisão do Marcel (D259); capítulos 06;08 são filtro de '
  'TELA, não de armazenamento. `icd_uri` é a URI canônica da OMS, guardada como IDENTIFICADOR '
  '(licença 1.2.2) — NUNCA um endereço que o código de produção resolve por HTTP. `kind=''extension''` '
  '(capítulo X, 17.160 códigos) não é diagnóstico e fica fora de `search()` por padrão.';

COMMENT ON COLUMN terminology.icd_entities.icd_uri IS
  'URI canônica da OMS (http://id.who.int/...). Identificador — nunca endereço para buscar. '
  'NÃO é PK sozinho desde a F1-correção D1: a identidade da linha é (icd_uri, release).';
COMMENT ON COLUMN terminology.icd_entities.parent_uri IS
  'Sem FK: blocos da OMS (classKind=block) não têm code e por isso não são linhas desta tabela '
  '— um parent_uri pode legitimamente não resolver aqui. Ver ancestorsOf() no adaptador.';

-- ── icd_synonyms — cláusula 1.2.4: campo ADICIONADO pela Enlite, marcado como tal ───────────
-- 🔧 F1-CORREÇÃO D1: ganha `release` e a FK vira composta `(icd_uri, release)`, espelhando a
-- nova identidade de `icd_entities`. Um sinônimo é editorial para uma entidade DE UM release
-- específico (o mesmo icd_uri pode, em tese, existir em dois releases com títulos diferentes —
-- o sinônimo não deveria "vazar" de um para o outro sem revisão humana).
CREATE TABLE IF NOT EXISTS terminology.icd_synonyms (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  icd_uri     TEXT        NOT NULL,
  release     TEXT        NOT NULL,
  term        TEXT        NOT NULL,
  lang        TEXT        NOT NULL,
  created_by  TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT icd_synonyms_lang_valido CHECK (lang IN ('es', 'en')),
  CONSTRAINT icd_synonyms_term_nao_vazio CHECK (btrim(term) <> ''),
  CONSTRAINT icd_synonyms_entity_fk FOREIGN KEY (icd_uri, release)
    REFERENCES terminology.icd_entities (icd_uri, release) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS icd_synonyms_unico_por_termo
  ON terminology.icd_synonyms (icd_uri, release, lower(term), lang);
CREATE INDEX IF NOT EXISTS idx_icd_synonyms_icd_uri ON terminology.icd_synonyms (icd_uri, release);
CREATE INDEX IF NOT EXISTS idx_icd_synonyms_term_trgm
  ON terminology.icd_synonyms USING GIN (term gin_trgm_ops);

COMMENT ON TABLE terminology.icd_synonyms IS
  'ATENÇÃO: conteúdo AUTORAL DA ENLITE — NÃO é original da OMS. Existe por permissão explícita '
  'da cláusula 1.2.4 da licença ICD-11 ("adding data fields... permitted if clearly identified '
  'as additions that do not originate from WHO"). Nasce vazia após a ingestão: a tolerância a '
  'erro de digitação da US-1 já é entregue por pg_trgm sobre os títulos oficiais da própria OMS '
  '(terminology.icd_entities); esta tabela é para termo que o trigram não cobrir (gíria, sigla '
  'regional), adicionado editorialmente pela operação — nunca por importação automática de '
  'conteúdo da OMS (ex.: NÃO copiar o indexTerm[] da API aqui — aquilo é conteúdo da OMS, isto '
  'é conteúdo nosso).';

-- ── GRANT ao enlite_mcp_ro — catálogo é dado PÚBLICO da OMS, não PHI ────────────────────────
-- Guardado atrás de checagem de existência: a role nasce em scripts/create-mcp-ro-role.sql,
-- que pode não ter rodado ainda neste ambiente (idempotente: repetir não falha).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'enlite_mcp_ro') THEN
    GRANT USAGE ON SCHEMA terminology TO enlite_mcp_ro;
    GRANT SELECT ON ALL TABLES IN SCHEMA terminology TO enlite_mcp_ro;
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA terminology GRANT SELECT ON TABLES TO enlite_mcp_ro',
      current_user
    );
  END IF;
END $$;
