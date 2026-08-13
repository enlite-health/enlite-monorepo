-- 269: roles de runtime sujeitas a RLS — app_runtime e app_system (ABAC país Fase 1)
--
-- Duas roles de GRUPO (NOLOGIN), não-owner, sem BYPASSRLS:
--   app_runtime — caminho de request do staff; sujeita às policies de país (mig 271).
--   app_system  — crons/jobs/webhooks/capabilities; passa pelas policies só com
--                 app.system_context setado explicitamente (nunca é o default).
--
-- Os USUÁRIOS de login (com senha) são criados por ambiente via terraform/Cloud SQL
-- (lex C4/D106: HCL + state alinhado) e entram nos grupos com:
--   GRANT app_runtime TO "<login-user>";
-- A virada real (trocar a connection do app) é a task 4.x da change, atrás de
-- COUNTRY_RLS_ENABLED — esta migration NÃO muda comportamento de prod/stg: a role
-- atual (enlite_app) é owner das tabelas e as policies (mig 271) entram sem FORCE.
--
-- Idempotente por DO-block: roles são cluster-wide; num cluster de e2e/dev reaproveitado
-- o CREATE ROLE cru falharia na segunda base que rodasse a suíte de migrations.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime NOLOGIN NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_system') THEN
    CREATE ROLE app_system NOLOGIN NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO app_runtime, app_system;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime, app_system;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime, app_system;

-- Objetos criados daqui em diante pelo dono das migrations herdam os mesmos grants
-- (sem FOR ROLE: aplica ao role corrente — enlite_app no Cloud SQL, enlite_admin no e2e).
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime, app_system;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_runtime, app_system;
