-- 561 — busca do catálogo CID-11 sem acento e por palavra: extensão `unaccent`, função de
-- normalização IMMUTABLE e índices trigrama sobre o texto normalizado.
--
-- Por quê: a busca tratava a frase inteira como um bloco e comparava texto cru. "depresion" (sem
-- acento) perdia para "Depresión al nacimiento"; "retraso mental leve" trazia ruído por pedaço de
-- palavra. O adaptador (`IcdCatalogTerminology`) agora compara `terminology.f_norm(texto)` com o
-- termo normalizado — para o índice ser usado, a expressão do índice tem de ser IDÊNTICA à da
-- consulta, e função usada em índice tem de ser IMMUTABLE. `unaccent()` é STABLE (depende do
-- dicionário), por isso o invólucro: `f_unaccent` fixa o dicionário `public.unaccent` e se declara
-- IMMUTABLE — o padrão documentado do PostgreSQL/pg_trgm para indexar texto sem acento.
--
-- Extensão: `unaccent` é "trusted" (PG ≥ 13): o dono do banco (enlite_app, que roda as migrations)
-- a cria sem superuser — mesmo caminho do `pg_trgm` (020) e do `btree_gist` (526). Medido: já
-- instalada em prd (dump de prd de 03/11/2026, `unaccent` no schema `public`), então o
-- `IF NOT EXISTS` é no-op lá e só cria em banco novo (CI/local).
--
-- Índices: GIN trigrama sobre `f_norm(title_es)`, `f_norm(title_en)` e `f_norm(term)`. Os índices
-- sobre o texto cru (323) ficam: o adaptador novo não os usa, mas removê-los é decisão à parte.
--
-- GRANT: função nova no schema `terminology` nasce sem GRANT explícito (a 324 revogou a herança de
-- tabelas, não a de funções — que é EXECUTE para PUBLIC); mesmo assim o EXECUTE de `app_runtime` e
-- `app_system` é dito aqui, para o diff mostrar quem usa (molde: 419).
--
-- Rollback: DROP INDEX terminology.idx_icd_entities_title_es_norm_trgm, ..._title_en_norm_trgm,
-- terminology.idx_icd_synonyms_term_norm_trgm; DROP FUNCTION terminology.f_norm(TEXT),
-- terminology.f_unaccent(TEXT). (A extensão fica: outros códigos já a usam.)
CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE OR REPLACE FUNCTION terminology.f_unaccent(input TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, input) $$;

CREATE OR REPLACE FUNCTION terminology.f_norm(input TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$ SELECT lower(terminology.f_unaccent(input)) $$;

COMMENT ON FUNCTION terminology.f_norm(TEXT) IS
  'Forma de comparação da busca do catálogo: minúsculas e sem acento (ñ→n, é→e). Fonte ÚNICA da '
  'regra — usada pelos índices trigrama (561) e pelo adaptador IcdCatalogTerminology. IMMUTABLE por '
  'declaração (invólucro de public.unaccent com dicionário fixo), para poder ser indexada.';

GRANT EXECUTE ON FUNCTION terminology.f_unaccent(TEXT), terminology.f_norm(TEXT) TO app_runtime, app_system;

CREATE INDEX IF NOT EXISTS idx_icd_entities_title_es_norm_trgm
  ON terminology.icd_entities USING GIN (terminology.f_norm(title_es) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_icd_entities_title_en_norm_trgm
  ON terminology.icd_entities USING GIN (terminology.f_norm(title_en) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_icd_synonyms_term_norm_trgm
  ON terminology.icd_synonyms USING GIN (terminology.f_norm(term) gin_trgm_ops);
