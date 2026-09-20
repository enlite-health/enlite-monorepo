-- 269: roles de runtime sujeitas a RLS — app_runtime e app_system (ABAC país Fase 1)
--
-- Duas roles de GRUPO (NOLOGIN), não-owner, sem BYPASSRLS:
--   app_runtime — caminho de request do staff; sujeita às policies de país (mig 271).
--   app_system  — crons/jobs/webhooks/capabilities; o atalho de sistema das policies
--                 exige MEMBRO desta role + app.system_context explícito (mig 271).
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
--
-- ⚠️ RE-RUN MANUAL: se este arquivo for re-executado à mão DEPOIS da 270 (fora do
-- runner, sem registrar em schema_migrations), os REVOKEs de least-privilege da 270
-- precisam ser re-aplicados em seguida — o grant em massa abaixo os desfaz.

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

-- Grants de DML tabela a tabela, SÓ nas relações que o role da migration pode
-- conceder (dono direto ou via membership). Um `GRANT ... ON ALL TABLES` cru
-- abortaria a migration inteira se UMA tabela do schema tivesse outro dono
-- (ex.: spatial_ref_sys de extensão, objeto criado à mão num incidente) — e em
-- prod o runner conecta como enlite_app, não superuser.
DO $$
DECLARE
  rel RECORD;
BEGIN
  FOR rel IN
    SELECT c.relname, c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p', 'S')
      AND pg_has_role(current_user, c.relowner, 'MEMBER')
  LOOP
    IF rel.relkind = 'S' THEN
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %I TO app_runtime, app_system', rel.relname);
    ELSE
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_runtime, app_system', rel.relname);
    END IF;
  END LOOP;
END
$$;

-- Objetos criados daqui em diante pelo dono das migrations herdam os mesmos grants
-- (sem FOR ROLE: aplica ao role corrente — enlite_app no Cloud SQL, enlite_admin no
-- e2e). ⚠️ Tabela sensível nova precisa REVOGAR explicitamente na própria migration
-- (padrão da 270) — os default privileges são deny-by-default só no schema, não por
-- tabela.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime, app_system;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_runtime, app_system;

-- ── Least-privilege sobre o próprio controle de acesso ──────────────────────────
-- As tabelas que DECIDEM o isolamento (a policy da 271 as consulta) são SELECT-only
-- para as roles do app: uma role confinada pela RLS não pode forjar o próprio grant
-- (INSERT em group_country_scopes / user_groups) nem des-revogar um escopo.
-- Criação/revogação de grupo é ato de admin via runbook (task 5.2), como owner.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON permission_groups, user_groups, group_country_scopes, group_permissions, tenants
  FROM app_runtime, app_system;

-- ── Trilhas de auditoria existentes: append-only para as roles do app ───────────
-- INSERT fica (os triggers SECURITY INVOKER que as alimentam rodam como o invocador)
-- e SELECT fica (telas de timeline/histórico). UPDATE/DELETE de trilha nunca é
-- caminho legítimo de runtime — manutenção excepcional roda como owner.
REVOKE UPDATE, DELETE, TRUNCATE
  ON worker_profile_changes_audit,
     permission_audit_log,
     worker_status_history,
     worker_job_application_stage_history,
     patient_chat_id_changes,
     patient_field_overrides_audit,
     vacancy_relink_audit,
     patient_status_history
  FROM app_runtime, app_system;
