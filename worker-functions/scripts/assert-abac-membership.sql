-- assert-abac-membership.sql — passo AUTORITATIVO da membership do ABAC de país
--
-- Uso (runbook `docs/runbook-abac-login-users.md`, passo 3):
--
--     psql "$DATABASE_URL" -f scripts/assert-abac-membership.sql
--
-- Por que existe, e por que não basta a migration 273:
--
-- A 273 concede a membership no boot — mas só para os usuários de login que JÁ EXISTIAM
-- naquele momento. Em stg/prd os usuários nascem pelo runbook, tipicamente DEPOIS de a
-- migration já ter rodado; ela passa sem conceder e o runner (`run-migrations-docker.js`)
-- a registra em `schema_migrations` por não ter havido erro. Resultado: ela não volta a
-- rodar sozinha, e a concessão ficaria pendente para sempre sem ninguém perceber.
--
-- Este script fecha essa lacuna. Ele:
--   1. CONCEDE (idempotente — GRANT de membership existente é no-op);
--   2. VERIFICA em `pg_auth_members` e FALHA com exceção se algo não estiver de pé;
--   3. NÃO toca em `schema_migrations`.
--
-- O item 3 é o ponto: a tentação de "registrar que rodei à mão" com um INSERT na tabela de
-- controle daria conflito de chave primária (o runner já inseriu a linha) e, pior, mentiria
-- — o arquivo de migration continua não tendo concedido nada.
--
-- Re-executável à vontade: rodar duas vezes seguidas dá exatamente o mesmo resultado.
--
-- Pré-requisito: conectar como um papel que possa conceder `app_runtime`/`app_system`
-- (`enlite_app` tem CREATEROLE — a 269 dependeu disso). Falha limpa se não puder.
--
-- ⚠️ Com `COUNTRY_RLS_ENABLED=true` o app RECUSA SUBIR sem esta membership (assert de
-- boot). Se o serviço está em crash-loop reclamando de membership, é este script que falta.

\set ON_ERROR_STOP on

DO $$
DECLARE
  pair       RECORD;
  faltando   TEXT[] := ARRAY[]::TEXT[];
  concedidas INT := 0;
BEGIN
  FOR pair IN
    SELECT * FROM (VALUES
      ('enlite_runtime', 'app_runtime'),
      ('enlite_system',  'app_system')
    ) AS t(login_user, group_role)
  LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = pair.group_role) THEN
      RAISE EXCEPTION '[abac] role de grupo % não existe — a migration 269 não rodou neste banco', pair.group_role;
    END IF;

    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = pair.login_user) THEN
      faltando := faltando || pair.login_user;
      CONTINUE;
    END IF;

    EXECUTE format('GRANT %I TO %I', pair.group_role, pair.login_user);
    concedidas := concedidas + 1;
  END LOOP;

  -- Usuário de login ausente é ERRO aqui (ao contrário da 273, que precisa tolerar):
  -- este script só é chamado pelo runbook, DEPOIS de criar os usuários. Se falta um,
  -- o passo 2 do runbook não foi feito neste ambiente.
  IF array_length(faltando, 1) IS NOT NULL THEN
    RAISE EXCEPTION '[abac] usuário(s) de login inexistente(s): %. Rodar o passo 2 do runbook (gcloud sql users create) antes deste script.',
      array_to_string(faltando, ', ');
  END IF;

  RAISE NOTICE '[abac] GRANT aplicado para % usuário(s) de login', concedidas;
END
$$;

-- ── Verificação: a asserção de verdade, lida do catálogo ─────────────────────────────
-- Não confiar no GRANT acima ter "passado": afirmar sobre pg_auth_members. Um GRANT que
-- silenciosamente não pegou (papel sem permissão de conceder, por exemplo) morre aqui.

DO $$
DECLARE
  pair    RECORD;
  ausente TEXT[] := ARRAY[]::TEXT[];
BEGIN
  FOR pair IN
    SELECT * FROM (VALUES
      ('enlite_runtime', 'app_runtime'),
      ('enlite_system',  'app_system')
    ) AS t(login_user, group_role)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_auth_members m
      JOIN pg_roles membro ON membro.oid = m.member
      JOIN pg_roles grupo  ON grupo.oid  = m.roleid
      WHERE membro.rolname = pair.login_user
        AND grupo.rolname  = pair.group_role
    ) THEN
      ausente := ausente || format('%s→%s', pair.login_user, pair.group_role);
    END IF;
  END LOOP;

  IF array_length(ausente, 1) IS NOT NULL THEN
    RAISE EXCEPTION '[abac] MEMBERSHIP AUSENTE depois do GRANT: %. O isolamento de país NÃO está de pé.',
      array_to_string(ausente, ', ');
  END IF;

  RAISE NOTICE '[abac] membership verificada em pg_auth_members — enlite_runtime→app_runtime e enlite_system→app_system OK';
END
$$;

-- Saída legível para colar no diário / no PR do runbook.
SELECT membro.rolname AS login_user,
       grupo.rolname  AS group_role,
       membro.rolcanlogin,
       membro.rolbypassrls
FROM pg_auth_members m
JOIN pg_roles membro ON membro.oid = m.member
JOIN pg_roles grupo  ON grupo.oid  = m.roleid
WHERE membro.rolname IN ('enlite_runtime', 'enlite_system')
ORDER BY membro.rolname;
