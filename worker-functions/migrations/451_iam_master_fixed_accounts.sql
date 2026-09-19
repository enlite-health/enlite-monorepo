-- 451 — B-1: mecanismo de conta fixa no Acesso Master (decisão do Gabriel, 19/09/2026)
--
-- POR QUÊ: o Acesso Master (id fixo a0000000-0000-0000-0000-000000000001, seed 206) hoje é
-- gerido pela UI como qualquer outro grupo — alguém pode remover, sem querer ou por engano, uma
-- das 5 contas que precisam ficar SEMPRE dentro dele. Decisão do Gabriel (19/09/2026): as 5
-- contas abaixo (fonte única: iam.master_fixed_emails()) são fixas no Master —
--   marcel@enlite.health · gabriel.g.stein@gmail.com · gabriel.stein@enlite.health ·
--   javier.bernal@enlite.health · diego.trevisan@enlite.health
-- `gabriel.g.stein@gmail.com` e `gabriel.stein@enlite.health` são DUAS contas distintas; domínio
-- externo (gmail) é aceito — a comparação nunca filtra por `@enlite.health`.
--
-- O QUE FAZ:
--   1. CATCH-UP (roda AGORA): concede o Master às 5 contas que já existem em `users`, ramo `iam`
--      e ramo `public` (molde da 436/432 — `run-migration-prod.sh` pode rodar numa base ainda em
--      `public`, seed 206 cru). Conta ausente vira WARNING nomeado — não falha o deploy.
--   2. Função `iam.grant_master_fixed_accounts()`, SECURITY DEFINER, MESMO gate da 436/281
--      (`app.system_context` declarado + ACL só `app_system`): INSERT idempotente. Chamada por
--      `PgPermissionCatalogRepository.sync()` a cada boot, na MESMA transação da 436 — é o
--      mecanismo que faz conta CRIADA DEPOIS desta migration entrar no Master sem ação humana.
--   3. Proteção anti-remoção, em DOIS triggers (a razão dos dois: medido nesta migration —
--      um só de `iam.user_groups` NÃO basta, ver "achado" abaixo):
--      a) `iam.trg_user_groups_guard_master_fixed()` em `iam.user_groups` (e em
--         `public.user_groups`, se for tabela real — pré-274): BEFORE DELETE OR UPDATE OF
--         removed_at. Pega `iam.remove_member` (UPDATE) e qualquer DELETE direto na tabela de
--         membership (script, psql manual).
--      b) `iam.trg_users_guard_master_fixed()` em `users` (mesmo molde da 410
--         `trg_users_guard_last_manager`): BEFORE DELETE. Pega o `DELETE FROM users`
--         (`DeleteAdminUserUseCase`/`AdminRepository.deleteByFirebaseUid`), que apaga a conta
--         inteira e CASCATEIA a remoção de `iam.user_groups` pela FK `ON DELETE CASCADE`.
--      ACHADO MEDIDO (não é só precaução): testado nesta migration que o trigger (a) sozinho
--      NÃO pega o caminho por CASCADE — quando `users` dispara o DELETE cascata em
--      `iam.user_groups`, o `SELECT email FROM users WHERE firebase_uid = OLD.user_id` dentro do
--      trigger do FILHO já não enxerga a linha do PAI (ela foi removida antes do Postgres disparar
--      a cascata) — `email` sai NULL e a proteção não dispara. Prova: `DELETE FROM users` para uma
--      das 5 contas removia a conta E a membership no Master silenciosamente, sem erro nenhum, até
--      o trigger (b) ser adicionado. Por isso o trigger em `users`, que enxerga `OLD.email`
--      diretamente (a linha ainda existe quando ele roda, por ser BEFORE na PRÓPRIA tabela), é
--      quem realmente fecha o caminho indireto — o mesmo raciocínio da 410 para `is_last_manager`.
--      `DeleteAdminUserUseCase` não tem `case` dedicado para este código novo — cai no `catch`
--      genérico (`Result.fail(error.message)`), não no ramo `LAST_MANAGER`; é comportamento
--      aceitável (falha, não silêncio) mas fora do escopo de B-1 mexer na ordem Firebase→banco
--      (mesma janela pré-existente do `last_manager`, já registrada no próprio use case).
--      Ambos os triggers, se a linha é do Master (group_id fixo, ou está numa live membership
--      no Master) e o e-mail está em `iam.master_fixed_emails()`, rejeitam com ERRCODE 23514
--      (mesma classe do anti-lockout da 410/279, marcador de mensagem PRÓPRIO — "conta fixa" —
--      para não colidir com a marca "anti-lockout" que `PermissionError.ts` já lê).
--
-- O QUE NÃO FAZ: não mexe em NENHUM outro grupo (Super Admin incluso — D285/432 tratam-no à
-- parte; fora do escopo nomeado de B-1); nunca REMOVE grant de ninguém; nunca cria usuário.
--
-- ROLLBACK: `DROP TRIGGER trg_user_groups_guard_master_fixed ON iam.user_groups` (+ `public.*`
-- se existir) + `DROP TRIGGER trg_users_guard_master_fixed ON users` +
-- `DROP FUNCTION iam.trg_user_groups_guard_master_fixed()` +
-- `DROP FUNCTION iam.trg_users_guard_master_fixed()` +
-- `DROP FUNCTION iam.grant_master_fixed_accounts()` + `DROP FUNCTION iam.master_fixed_emails()`.
-- As linhas de `iam.user_groups` concedidas pelo catch-up ficam (nunca DELETE por esta migration;
-- remover manualmente se for o caso, pelo próprio `iam.remove_member`).

BEGIN;

-- ── fonte única das 5 contas fixas ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION iam.master_fixed_emails()
RETURNS TEXT[]
LANGUAGE sql IMMUTABLE
AS $$
  SELECT ARRAY[
    'marcel@enlite.health',
    'gabriel.g.stein@gmail.com',
    'gabriel.stein@enlite.health',
    'javier.bernal@enlite.health',
    'diego.trevisan@enlite.health'
  ];
$$;
COMMENT ON FUNCTION iam.master_fixed_emails() IS
  'Fonte única das 5 contas fixas do Acesso Master (B-1, decisão do Gabriel 19/09/2026). '
  'Comparação sempre por lower(email); domínio externo (gmail) é aceito.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    REVOKE ALL ON FUNCTION iam.master_fixed_emails() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION iam.master_fixed_emails() TO app_runtime, app_system;
  END IF;
END
$$;

-- ── 1. Catch-up: concede o Master a quem das 5 já existe em `users`, hoje ─────────
DO $$
DECLARE
  v_master_id CONSTANT UUID := 'a0000000-0000-0000-0000-000000000001';
  v_tenant_id CONSTANT UUID := '00000000-0000-0000-0000-000000000001';
  v_n INT;
  v_missing TEXT[];
BEGIN
  IF to_regclass('iam.permission_groups') IS NOT NULL THEN
    INSERT INTO iam.user_groups (user_id, group_id, tenant_id)
    SELECT u.firebase_uid, v_master_id, v_tenant_id
      FROM users u
     WHERE lower(u.email) IN (SELECT lower(x) FROM unnest(iam.master_fixed_emails()) x)
       AND NOT EXISTS (
         SELECT 1 FROM iam.user_groups ug
          WHERE ug.user_id = u.firebase_uid AND ug.group_id = v_master_id AND ug.removed_at IS NULL
       );
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE '[451] catch-up iam.user_groups: % conta(s) fixa(s) adicionada(s) ao Acesso Master', v_n;
  END IF;

  IF to_regclass('public.permission_groups') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'permission_groups' AND c.relkind = 'r'
     )
  THEN
    INSERT INTO public.user_groups (user_id, group_id, tenant_id)
    SELECT u.firebase_uid, v_master_id, v_tenant_id
      FROM users u
     WHERE lower(u.email) IN (SELECT lower(x) FROM unnest(iam.master_fixed_emails()) x)
       AND NOT EXISTS (
         SELECT 1 FROM public.user_groups ug
          WHERE ug.user_id = u.firebase_uid AND ug.group_id = v_master_id
       )
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE '[451] catch-up public.user_groups: % conta(s) fixa(s) adicionada(s) ao Acesso Master', v_n;
  END IF;

  SELECT array_agg(email) INTO v_missing
    FROM unnest(iam.master_fixed_emails()) email
   WHERE NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(email));
  IF v_missing IS NOT NULL THEN
    RAISE WARNING '[451] conta(s) fixa(s) ainda inexistente(s) em users — entram no Master quando forem criadas, via iam.grant_master_fixed_accounts() no próximo boot (não falha o deploy): %', v_missing;
  END IF;
END
$$;

-- ── 2. Função de boot (mesmo gate/ACL da 436) ─────────────────────────────────────
DO $outer$
BEGIN
  IF to_regclass('iam.permission_groups') IS NOT NULL THEN
    EXECUTE $ddl$
      CREATE OR REPLACE FUNCTION iam.grant_master_fixed_accounts()
      RETURNS INT
      LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = pg_catalog, iam, public
      AS $fn$
      DECLARE
        v_master_id CONSTANT UUID := 'a0000000-0000-0000-0000-000000000001';
        v_tenant_id CONSTANT UUID := '00000000-0000-0000-0000-000000000001';
        v_n INT;
        v_missing TEXT[];
      BEGIN
        IF NOT iam._is_system_context() THEN
          RAISE EXCEPTION USING ERRCODE = '42501',
            MESSAGE = '[iam] conceder conta fixa ao Acesso Master exige app.system_context declarado';
        END IF;

        INSERT INTO iam.user_groups (user_id, group_id, tenant_id)
        SELECT u.firebase_uid, v_master_id, v_tenant_id
          FROM users u
         WHERE lower(u.email) IN (SELECT lower(x) FROM unnest(iam.master_fixed_emails()) x)
           AND NOT EXISTS (
             SELECT 1 FROM iam.user_groups ug
              WHERE ug.user_id = u.firebase_uid AND ug.group_id = v_master_id AND ug.removed_at IS NULL
           );
        GET DIAGNOSTICS v_n = ROW_COUNT;

        SELECT array_agg(email) INTO v_missing
          FROM unnest(iam.master_fixed_emails()) email
         WHERE NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(email));
        IF v_missing IS NOT NULL THEN
          RAISE WARNING '[451] conta(s) fixa(s) ainda inexistente(s) em users: %', v_missing;
        END IF;

        RETURN v_n;
      END;
      $fn$
    $ddl$;

    EXECUTE $c$COMMENT ON FUNCTION iam.grant_master_fixed_accounts() IS
      'B-1 (decisão Gabriel 19/09/2026): as 5 contas fixas (iam.master_fixed_emails()) recebem '
      'automaticamente o Acesso Master a cada sync de boot — reconcilia conta criada depois desta '
      'migration, sem ação humana. INSERT idempotente; nunca remove grant, nunca toca outro grupo.'$c$;

    EXECUTE 'REVOKE ALL ON FUNCTION iam.grant_master_fixed_accounts() FROM PUBLIC';
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
      EXECUTE 'REVOKE ALL ON FUNCTION iam.grant_master_fixed_accounts() FROM app_runtime';
      EXECUTE 'GRANT EXECUTE ON FUNCTION iam.grant_master_fixed_accounts() TO app_system';
    END IF;
  END IF;
END
$outer$;

-- ── 3. Proteção anti-remoção (mesma classe do anti-lockout da 410/279) ────────────
CREATE OR REPLACE FUNCTION iam.trg_user_groups_guard_master_fixed()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, iam, public
AS $$
DECLARE
  v_master_id CONSTANT UUID := 'a0000000-0000-0000-0000-000000000001';
  v_email VARCHAR;
BEGIN
  IF OLD.group_id IS DISTINCT FROM v_master_id THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- UPDATE só interessa quando o vínculo SAI de vivo (removed_at NULL → preenchido).
  -- Tabela sem a coluna (ramo `public` pré-274) só dispara por DELETE — TG_OP nunca é 'UPDATE' aqui.
  IF TG_OP = 'UPDATE' AND NOT (OLD.removed_at IS NULL AND NEW.removed_at IS NOT NULL) THEN
    RETURN NEW;
  END IF;

  SELECT u.email INTO v_email FROM users u WHERE u.firebase_uid = OLD.user_id;
  IF v_email IS NOT NULL AND lower(v_email) IN (SELECT lower(x) FROM unnest(iam.master_fixed_emails()) x) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = format('[iam] %s rejeitado: %s é conta fixa do Acesso Master (B-1) — protegida contra remoção', TG_OP, v_email);
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION iam.trg_user_groups_guard_master_fixed() IS
  'B-1: rejeita (23514, marca "conta fixa") remover uma das 5 contas fixas do Acesso Master — '
  'via iam.remove_member (UPDATE removed_at) ou via exclusão da conta inteira (DELETE em cascata '
  'de users). Nunca remove grant de ninguém; só bloqueia a remoção das 5.';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'iam' AND c.relname = 'user_groups' AND c.relkind = 'r'
  ) THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_user_groups_guard_master_fixed ON iam.user_groups';
    EXECUTE 'CREATE TRIGGER trg_user_groups_guard_master_fixed
               BEFORE DELETE OR UPDATE OF removed_at ON iam.user_groups
               FOR EACH ROW EXECUTE FUNCTION iam.trg_user_groups_guard_master_fixed()';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'user_groups' AND c.relkind = 'r'
  ) THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_user_groups_guard_master_fixed ON public.user_groups';
    EXECUTE 'CREATE TRIGGER trg_user_groups_guard_master_fixed
               BEFORE DELETE ON public.user_groups
               FOR EACH ROW EXECUTE FUNCTION iam.trg_user_groups_guard_master_fixed()';
  END IF;

  -- Mesmo molde da 410 (trg_users_guard_last_manager): REVOKE de PUBLIC, sem GRANT explícito —
  -- o disparo do trigger não passa pelo checador de EXECUTE do chamador.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    REVOKE ALL ON FUNCTION iam.trg_user_groups_guard_master_fixed() FROM PUBLIC;
  END IF;
END
$$;

-- ── 3b. Trigger em `users` — fecha o caminho por CASCADE (achado acima; molde da 410) ─────
CREATE OR REPLACE FUNCTION iam.trg_users_guard_master_fixed()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, iam, public
AS $$
DECLARE
  v_master_id CONSTANT UUID := 'a0000000-0000-0000-0000-000000000001';
  v_e_membro BOOLEAN;
BEGIN
  IF lower(OLD.email) NOT IN (SELECT lower(x) FROM unnest(iam.master_fixed_emails()) x) THEN
    RETURN OLD;
  END IF;

  -- Só bloqueia se HOJE é membro vivo do Master — a garantia é "não remove do Master",
  -- não "a conta nunca pode ser apagada" (ficaria acoplado a uma decisão maior que B-1).
  SELECT EXISTS (
    SELECT 1 FROM iam.user_groups ug
     WHERE ug.user_id = OLD.firebase_uid AND ug.group_id = v_master_id AND ug.removed_at IS NULL
  ) INTO v_e_membro;

  IF NOT v_e_membro AND to_regclass('public.user_groups') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'user_groups' AND c.relkind = 'r'
     )
  THEN
    SELECT EXISTS (
      SELECT 1 FROM public.user_groups ug
       WHERE ug.user_id = OLD.firebase_uid AND ug.group_id = v_master_id
    ) INTO v_e_membro;
  END IF;

  IF v_e_membro THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = format('[iam] DELETE rejeitado: %s é conta fixa do Acesso Master (B-1) — protegida contra remoção', OLD.email);
  END IF;

  RETURN OLD;
END;
$$;
COMMENT ON FUNCTION iam.trg_users_guard_master_fixed() IS
  'B-1: fecha o caminho indireto que o trigger de iam.user_groups sozinho NÃO pega — DELETE FROM '
  'users cascateando para iam.user_groups (a linha do pai já não existe quando o trigger do filho '
  'roda; medido nesta migration). Bloqueia apagar a conta enquanto ela for membro vivo do Master; '
  'não impede apagar a conta se ela não for membro (fora do escopo de B-1).';

DO $$
BEGIN
  EXECUTE 'DROP TRIGGER IF EXISTS trg_users_guard_master_fixed ON users';
  EXECUTE 'CREATE TRIGGER trg_users_guard_master_fixed
             BEFORE DELETE ON users
             FOR EACH ROW EXECUTE FUNCTION iam.trg_users_guard_master_fixed()';

  -- Mesmo molde da 410: REVOKE de PUBLIC, sem GRANT explícito (trigger não passa por EXECUTE).
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    REVOKE ALL ON FUNCTION iam.trg_users_guard_master_fixed() FROM PUBLIC;
  END IF;
END
$$;

COMMIT;
