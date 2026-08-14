-- 273: liga os usuários de LOGIN às roles de grupo do ABAC (abac-pais-fase1, task 2.2)
--
-- A 269 criou `app_runtime` e `app_system` NOLOGIN — elas carregam permissão, não
-- conexão. Quem conecta são `enlite_runtime` e `enlite_system`, criados por ambiente
-- (runbook `docs/runbook-abac-login-users.md`, importados no terraform). Esta migration
-- é a costura entre os dois: o GRANT de membership.
--
-- Por que aqui e não no terraform: membership de role é objeto DENTRO do Postgres, não
-- recurso do GCP. O terraform cria o usuário (existe/não existe); o que ele pode fazer é
-- do banco — e assim a regra vale igual em e2e, stg e prd.
--
-- ⚠️ ESTA MIGRATION NÃO É A GARANTIA DA CONCESSÃO. Ela só concede a quem JÁ EXISTE no
-- momento em que roda. Onde os usuários de login nascem DEPOIS do deploy (o caso normal:
-- o runbook cria em stg/prd fora da esteira), a migration passa sem conceder e o runner
-- a registra em `schema_migrations` — o que quer dizer que ela NÃO VOLTA a rodar sozinha.
-- Nesse cenário o passo AUTORITATIVO é o do runbook, com o script standalone:
--
--     psql -f scripts/assert-abac-membership.sql
--
-- que faz o mesmo GRANT, verifica em `pg_auth_members` e FALHA se a membership não estiver
-- de pé. Ele é re-executável à vontade e não toca em `schema_migrations` (por isso é o
-- caminho certo para rodar à mão — um INSERT manual na tabela de controle daria conflito
-- de chave primária com o registro que o runner já fez).
--
-- Tolerância à ausência: num ambiente onde o usuário de login ainda não existe (e2e local,
-- stg antes do runbook) a migration NÃO PODE FALHAR — ela só não tem o que ligar. Sem essa
-- tolerância, a cadeia inteira de migrations quebraria no boot de todo ambiente que ainda
-- não passou pelo runbook. O aviso sai como WARNING (não NOTICE) justamente para aparecer
-- no log de deploy: "passou" aqui não significa "concedido".
--
-- ⚠️ Não faz o inverso (revogar): tirar alguém de app_runtime é ato de operação, com
-- registro no diário — não efeito colateral de deploy.

DO $$
DECLARE
  pair RECORD;
  pendentes TEXT[] := ARRAY[]::TEXT[];
BEGIN
  FOR pair IN
    SELECT * FROM (VALUES
      ('enlite_runtime', 'app_runtime'),
      ('enlite_system',  'app_system')
    ) AS t(login_user, group_role)
  LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = pair.group_role) THEN
      RAISE EXCEPTION '[abac] role de grupo % não existe — a migration 269 não rodou', pair.group_role;
    END IF;

    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = pair.login_user) THEN
      pendentes := pendentes || pair.login_user;
      RAISE WARNING '[abac] CONCESSÃO PENDENTE: usuário de login % ainda não existe neste ambiente. Esta migration será registrada como aplicada e NÃO voltará a rodar — quando o usuário for criado, o GRANT % TO % é responsabilidade do runbook (psql -f scripts/assert-abac-membership.sql).',
        pair.login_user, pair.group_role, pair.login_user;
      CONTINUE;
    END IF;

    -- Idempotente: GRANT de membership já existente é no-op no Postgres.
    EXECUTE format('GRANT %I TO %I', pair.group_role, pair.login_user);
    RAISE NOTICE '[abac] % agora é membro de %', pair.login_user, pair.group_role;
  END LOOP;

  IF array_length(pendentes, 1) IS NOT NULL THEN
    RAISE WARNING '[abac] 273 terminou com % concessão(ões) PENDENTE(S): %. O isolamento de país NÃO está de pé para esse(s) usuário(s). Rodar scripts/assert-abac-membership.sql depois de criá-lo(s).',
      array_length(pendentes, 1), array_to_string(pendentes, ', ');
  END IF;
END
$$;
