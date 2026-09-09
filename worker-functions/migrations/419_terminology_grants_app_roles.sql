-- 419 — o papel de RUNTIME não enxergava o catálogo CID-11 (schema `terminology`).
--
-- Medido na stage em 08/09/2026 (D303, fecho): a API conecta como `enlite_runtime` (membro de
-- `app_runtime`, RLS ligado — 269/271/273) e `GET /api/admin/terminology/search` respondia 503
-- "error de infraestructura" mesmo com 35.692 entidades na base: `has_schema_privilege('app_runtime',
-- 'terminology', 'USAGE') = false`. A 271 concedeu `public` (tabelas + default privileges), a 274
-- cuidou de `iam`, e a 323 criou `terminology` DEPOIS, concedendo só a `enlite_app` (dona) e ao
-- `enlite_mcp_ro`. Em prod não apareceu porque lá a API ainda conecta como `enlite_app`
-- (`DB_USER`); apareceria na virada do RLS — esta migration fecha a classe antes.
--
-- Só LEITURA: nenhum código de produção escreve em `terminology.*` (o ingestor roda como
-- `enlite_app`, fora da esteira; sinônimos T9 são cadastrados por operação). Guardado por
-- existência das roles, como a 323 — no e2e local elas nascem na 269. Idempotente: GRANT
-- repetido é no-op.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_system') THEN
    GRANT USAGE ON SCHEMA terminology TO app_runtime, app_system;
    GRANT SELECT ON ALL TABLES IN SCHEMA terminology TO app_runtime, app_system;
    -- Tabela futura no schema (release novo não cria tabela, mas a regra vale): nasce legível.
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA terminology GRANT SELECT ON TABLES TO app_runtime, app_system',
      current_user
    );
  ELSE
    RAISE WARNING '[419] app_runtime/app_system ausentes neste ambiente — nada concedido (a 269 cria as roles).';
  END IF;
END $$;
