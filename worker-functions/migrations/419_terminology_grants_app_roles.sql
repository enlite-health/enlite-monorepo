-- 419 — o papel de RUNTIME não enxergava o catálogo CID-11 (schema `terminology`).
--
-- Medido na stage em 08/09/2026 (D303, fecho): a API conecta como `enlite_runtime` (membro de
-- `app_runtime`, RLS ligado — 269/271/273) e `GET /api/admin/terminology/search` respondia 503
-- "error de infraestructura" mesmo com 35.692 entidades na base (copiadas de prod, onde o
-- catálogo foi ingerido; o ingestor `scripts/ingest-icd11-catalog.ts` só aceita banco LOCAL —
-- `assertLocalDatabaseTarget`): `has_schema_privilege('app_runtime', 'terminology', 'USAGE') = false`.
-- A 271 concedeu `public`, a 274 cuidou de `iam`, e a 323 criou `terminology` DEPOIS, concedendo
-- só a `enlite_app` (dona) e ao `enlite_mcp_ro`. Em prod não apareceu porque lá a API ainda
-- conecta como `enlite_app` (`DB_USER`); apareceria na virada do RLS — esta migration fecha antes.
--
-- Concessão EXPLÍCITA, por tabela, e só de leitura:
--   · nenhum código de produção escreve em `terminology.*` (sinônimos T9 são cadastrados por
--     operação; o ingestor roda como dono, fora da esteira);
--   · SEM `ALTER DEFAULT PRIVILEGES`: a 324 revogou exatamente essa herança automática neste
--     schema (D261/C4, governança item 4) — tabela futura do `terminology` nasce ILEGÍVEL até
--     uma migration decidir o GRANT dela, para qualquer papel;
--   · sem `ON ALL TABLES`: a lista é a das 3 tabelas de hoje, revisável neste diff.
--
-- Sem guarda de existência das roles: a 269 as cria sempre, antes desta. Se faltarem, o GRANT
-- FALHA ALTO (42704) e a migration NÃO é registrada — o runner não imprime `RAISE WARNING`, e
-- "aplicada sem conceder" seria o mesmo 503 de volta, agora invisível. Idempotente: GRANT
-- repetido é no-op.
GRANT USAGE ON SCHEMA terminology TO app_runtime, app_system;
GRANT SELECT ON terminology.icd_releases TO app_runtime, app_system;
GRANT SELECT ON terminology.icd_entities TO app_runtime, app_system;
GRANT SELECT ON terminology.icd_synonyms TO app_runtime, app_system;
