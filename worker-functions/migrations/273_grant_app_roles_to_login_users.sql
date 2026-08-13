-- 273: liga os usuários de LOGIN às roles de grupo do ABAC (abac-pais-fase1, task 2.2)
--
-- A 269 criou `app_runtime` e `app_system` NOLOGIN — elas carregam permissão, não
-- conexão. Quem conecta são `enlite_runtime` e `enlite_system`, criados por ambiente
-- (runbook `docs/runbook-abac-login-users.md`, importados no terraform). Esta migration
-- é a costura entre os dois: o GRANT de membership.
--
-- Por que aqui e não no terraform: membership de role é objeto DENTRO do Postgres, não
-- recurso do GCP. O terraform cria o usuário (existe/não existe); o que ele pode fazer é
-- do banco — e assim a regra vale igual em e2e, stg e prd, sem depender de alguém rodar
-- um comando à mão depois.
--
-- Idempotente e TOLERANTE À AUSÊNCIA de propósito: num ambiente onde o usuário de login
-- ainda não foi criado (e2e local, stg antes do runbook), a migration não pode falhar —
-- ela só não tem o que ligar. Sem essa tolerância, a cadeia inteira de migrations
-- quebraria no boot de todo ambiente que ainda não passou pelo runbook.
--
-- ⚠️ Não faz o inverso (revogar): tirar alguém de app_runtime é ato de operação, com
-- registro no diário — não efeito colateral de deploy.

DO $$
DECLARE
  pair RECORD;
BEGIN
  FOR pair IN
    SELECT * FROM (VALUES
      ('enlite_runtime', 'app_runtime'),
      ('enlite_system',  'app_system')
    ) AS t(login_user, group_role)
  LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = pair.login_user) THEN
      RAISE NOTICE '[abac] usuário de login % ainda não existe neste ambiente — GRANT pulado', pair.login_user;
      CONTINUE;
    END IF;

    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = pair.group_role) THEN
      RAISE EXCEPTION '[abac] role de grupo % não existe — a migration 269 não rodou', pair.group_role;
    END IF;

    EXECUTE format('GRANT %I TO %I', pair.group_role, pair.login_user);
    RAISE NOTICE '[abac] % agora é membro de %', pair.login_user, pair.group_role;
  END LOOP;
END
$$;
