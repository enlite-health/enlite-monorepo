-- 328 — `concept_key`: identidade de conceito ESTÁVEL ENTRE RELEASES (spec 016, correções do
-- QA-caça da F5 — T2/T3/T4 do "modelo de release do CID-11")
--
-- ── O DEFEITO QUE ESTA MIGRATION EXISTE PARA FECHAR ─────────────────────────────────────────
-- `terminology.icd_entities.icd_uri` é a URI canônica da OMS, e a OMS ENCRAVA O RELEASE NO PATH:
--   http://id.who.int/icd/release/11/2026-01/mms/405565289/unspecified
--                                    ^^^^^^^
-- Consequência medida (05/09/2026): o MESMO conceito tem `icd_uri` DIFERENTE em cada release.
-- Isso quebra, de uma vez, três coisas que pareciam independentes:
--
--   1. O mapa do ClickUp (`clickup_diagnosis_labels`, migration 327) guarda a URI COM o release
--      dentro. Quem resolve (`RecordPatientDiagnosis` → `TerminologyPort.getByUri`) filtra pelo
--      release CORRENTE. No dia da primeira promoção, os 8 mapeamentos param de resolver DE UMA
--      VEZ — e em silêncio: a busca da operadora continua funcionando (a URI dela vem do release
--      corrente), o espelho loga `info`, o webhook devolve 200, e NENHUMA linha de rejeição é
--      gravada (`recordUnmapped` só roda no ramo "rótulo sem linha no mapa").
--      O COMMENT da 326 e o cabeçalho de `ClickUpDiagnosisLabelRepository.ts` NOMEIAM esse risco
--      por escrito — "uma URI copiada aqui e outra resolvida ali podem divergir do catálogo em
--      releases diferentes" — e a 327 gravou a URI com o release dentro assim mesmo.
--
--   2. A reconciliação de `--promote` compara `old_e.icd_uri = new_e.icd_uri`. Como a URI muda
--      com o release, essa comparação NUNCA casa: ela reportaria os 35.692 conceitos do release
--      anterior como "ausentes no novo". Um número que é sempre 100% não informa nada — é o
--      "instrumento morto" que o CLAUDE.md chama de contagem que não mede.
--
--   3. O diagnóstico já gravado do paciente (`patient_diagnoses.concept_uri`) fica sem caminho de
--      volta ao catálogo depois da promoção, pelo mesmo motivo.
--
-- ── A ESCOLHA: identidade estável, resolução normaliza (opção "a") ─────────────────────────────
-- O que é estável entre releases na URI da OMS é tudo o que vem DEPOIS do segmento de release:
-- a linearização + o id da entidade (`mms/405565289/unspecified`). `concept_key` é exatamente
-- isso, derivado por coluna GERADA — nada para o ingestor preencher, nada para desincronizar, e
-- impossível de gravar errado (o Postgres calcula).
--
-- A alternativa descartada era guardar a URI como está e obrigar `--promote` a REAPONTAR o mapa
-- do ClickUp a cada promoção. Rejeitada por três motivos: (i) exigiria uma migration de dado a
-- cada release, (ii) poria o CLI a ESCREVER numa tabela de configuração operacional dentro da
-- transação de promoção — se a promoção reverte, o mapa fica reapontado para um release que não
-- é o corrente, e (iii) não conserta os itens 2 e 3 acima, que não têm nada a ver com o ClickUp.
--
-- ⚠️ POR QUE UMA MIGRATION NOVA, E NÃO EDITAR A 327: o runner rastreia migration por NOME DE
-- ARQUIVO e a 327 JÁ RODOU (medido no `enlite_e2e` local) — editá-la não a faz rodar de novo.
-- Esta migration NÃO reescreve dado nenhum de `clickup_diagnosis_labels`: as 8 URIs de lá
-- continuam exatamente como a 327 as gravou, e passam a resolver porque quem RESOLVE normaliza.
-- Isso é deliberado — o mapa é conteúdo operacional (cláusula 1.2.4, "nosso"), e uma correção de
-- ENGENHARIA não deve reescrever uma escolha de OPERAÇÃO.
--
-- Idempotente e re-rodável: `CREATE OR REPLACE FUNCTION` + `ADD COLUMN IF NOT EXISTS` +
-- `CREATE UNIQUE INDEX IF NOT EXISTS`. Rodar 2× não muda o resultado.
--
-- Rollback: DROP INDEX terminology.icd_entities_concept_key_unico;
--           ALTER TABLE terminology.icd_entities DROP COLUMN concept_key;
--           DROP FUNCTION terminology.concept_key(TEXT);

BEGIN;

-- ── A REGRA, EM UM LUGAR SÓ ─────────────────────────────────────────────────────────────────
-- IMMUTABLE porque é substituição textual pura (mesma entrada → mesma saída, sempre) — é o que
-- permite usá-la numa coluna GERADA e num índice, e o que faz o planner tratar
-- `concept_key($1)` como constante (Index Scan, não Seq Scan).
-- URI sem o marcador `/icd/release/11/<release>/` (fixture de teste, vocabulário futuro que não
-- seja a OMS) passa INTACTA — a chave vira a própria URI, que é o comportamento de hoje.
CREATE OR REPLACE FUNCTION terminology.concept_key(uri TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$ SELECT regexp_replace(uri, '^.*/icd/release/11/[^/]+/', '') $$;

COMMENT ON FUNCTION terminology.concept_key(TEXT) IS
  'Identidade de conceito ESTÁVEL entre releases: a URI da OMS sem o segmento de release '
  '(http://id.who.int/icd/release/11/2026-01/mms/405565289 -> mms/405565289). Fonte ÚNICA da '
  'regra — usada pela coluna gerada icd_entities.concept_key, pelo índice, pelo adaptador '
  '(IcdCatalogTerminology) e pela reconciliação de --promote (scripts/ingest-icd11-catalog.ts). '
  'URI sem o marcador passa intacta.';

ALTER TABLE terminology.icd_entities
  ADD COLUMN IF NOT EXISTS concept_key TEXT
  GENERATED ALWAYS AS (terminology.concept_key(icd_uri)) STORED;

COMMENT ON COLUMN terminology.icd_entities.concept_key IS
  'GERADA a partir de icd_uri (terminology.concept_key): o mesmo conceito tem esta chave IGUAL '
  'em todos os releases, enquanto icd_uri muda (a OMS encrava o release no path). É por ela que '
  'getByUri resolve, que a reconciliação de --promote conta órfão de verdade, e que o mapa do '
  'ClickUp da 327 continua resolvendo depois de promover um release novo. Nada a preencher: o '
  'Postgres calcula.';

-- MEDIDO antes de escrever este índice (release 2026-01 do enlite_e2e):
--   SELECT count(*), count(DISTINCT concept_key) -> 35692 / 35692.
-- UNIQUE, e não um índice comum, porque "um conceito aparece no máximo uma vez por release" é
-- uma INVARIANTE, não uma conveniência: sem ela, `getByUri` pegaria `rows[0]` de um empate e a
-- escolha ficaria arbitrária e silenciosa. Se algum dia um release violar isso, esta migration
-- falha ALTO na hora de aplicar — que é o comportamento certo.
CREATE UNIQUE INDEX IF NOT EXISTS icd_entities_concept_key_unico
  ON terminology.icd_entities (release, concept_key);

COMMIT;
