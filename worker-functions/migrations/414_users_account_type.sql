-- 414 — `users.account_type`: o TIPO da conta sai de `users.role` (D294, 07/09/2026)
--
-- `users.role` fazia duas coisas: nível de acesso (retirado na D293 — a célula
-- decide) e fronteira staff × prestador. Esta migration cria a coluna que
-- responde só "o que a conta É": `staff` | `worker` hoje; obra social, paciente e
-- os próximos entram alargando o CHECK (migration própria, junto com o código
-- que os usa — nunca por `role`).
--
-- Medido antes (07/09): `users` só tem staff em prod (18) e stage (30); os
-- valores legados `manager`/`support`/`client` (mig 003) não existem em nenhum
-- ambiente. O prestador vive em `workers.auth_uid` e não tem linha aqui.
--
-- Três peças, na ordem:
--   1. coluna + backfill por `account_type_for_role(role)` — a MESMA ponte que o
--      código TS tem (`domain/AccountType.ts`). Papel que não classifica levanta
--      exceção: fail-closed, uma linha sem tipo não pode nascer "staff" por
--      acidente, e a migration inteira volta.
--   2. NOT NULL + CHECK, só depois do backfill.
--   3. trigger BEFORE INSERT OR UPDATE OF role que deriva o tipo quando a linha
--      vem só com `role`: há 130+ seeds de e2e, scripts de espelho e o
--      `create_user_with_role` que inserem `users` sem conhecer a coluna nova, e
--      `change_user_role` (mig 102) ainda faz UPDATE de `role` — sem cobrir o
--      UPDATE, um `admin → worker` deixaria a conta com a fronteira de staff
--      (`lex` C3). O trigger some junto com `role` (D293, passo 3).
--
-- Parecer do `lex` (07/09, CONDICIONADO): C1 mapa por ALLOWLIST (só os 3 papéis
-- viram `staff`; o resto levanta) · C2 contagem por papel medida em stg e prd
-- ANTES desta migration (só admin/recruiter/community_manager; zero legado) ·
-- C3 o UPDATE também deriva · C6 `patient`/`obra_social` NÃO entram no CHECK sem
-- novo parecer: a coluna passaria a revelar que a pessoa recebe cuidado de saúde
-- (LGPD art. 5º II; Ley 25.326 art. 2 e 7 inc. 3).
--
-- Idempotente: `ADD COLUMN IF NOT EXISTS`, `CREATE OR REPLACE`, `DROP ... IF EXISTS`.

BEGIN;

-- ── ponte papel → tipo (espelho de accountTypeForRole em domain/AccountType.ts) ──
CREATE OR REPLACE FUNCTION account_type_for_role(p_role TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF p_role IN ('admin', 'recruiter', 'community_manager') THEN
    RETURN 'staff';
  ELSIF p_role = 'worker' THEN
    RETURN 'worker';
  END IF;
  RAISE EXCEPTION 'account_type_for_role: papel % não classifica o tipo da conta', p_role
    USING ERRCODE = 'check_violation';
END;
$$;

COMMENT ON FUNCTION account_type_for_role(TEXT) IS
  'Ponte legado: users.role → users.account_type. Some junto com a coluna role (D293 passo 3).';

-- ── 1. coluna + backfill ──────────────────────────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_type VARCHAR(30);

UPDATE users
   SET account_type = account_type_for_role(role)
 WHERE account_type IS NULL;

-- ── 2. amarras, só depois do backfill ────────────────────────────────────────
ALTER TABLE users ALTER COLUMN account_type SET NOT NULL;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_account_type_check;
ALTER TABLE users ADD CONSTRAINT users_account_type_check
  CHECK (account_type IN ('staff', 'worker'));

CREATE INDEX IF NOT EXISTS idx_users_account_type ON users(account_type);

COMMENT ON COLUMN users.account_type IS
  'O que a conta É (staff | worker). Não é nível de acesso: isso é célula do grupo (iam.*). '
  'PROIBIDO incluir patient/obra_social no CHECK sem novo parecer do lex (07/09/2026, C6): '
  'a coluna passaria a revelar dado de saúde por via indireta (LGPD art. 5 II; Ley 25.326 art. 2 e 7.3).';

-- ── 3. trigger: linha que chega só com `role` ganha o tipo pela ponte ────────
-- INSERT: sem tipo declarado → deriva. UPDATE de `role` (lex C3): se o papel
-- mudou e ninguém mexeu no tipo na mesma instrução, o tipo segue o papel novo.
CREATE OR REPLACE FUNCTION users_account_type_from_role()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.account_type IS NULL THEN
      NEW.account_type := account_type_for_role(NEW.role);
    END IF;
  ELSIF NEW.role IS DISTINCT FROM OLD.role
        AND NEW.account_type IS NOT DISTINCT FROM OLD.account_type THEN
    NEW.account_type := account_type_for_role(NEW.role);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_users_account_type_from_role ON users;
CREATE TRIGGER trg_users_account_type_from_role
  BEFORE INSERT OR UPDATE OF role ON users
  FOR EACH ROW
  EXECUTE FUNCTION users_account_type_from_role();

-- ── prova de que o backfill fechou ───────────────────────────────────────────
DO $$
DECLARE
  v_sem_tipo INT;
BEGIN
  SELECT count(*) INTO v_sem_tipo FROM users WHERE account_type IS NULL;
  IF v_sem_tipo > 0 THEN
    RAISE EXCEPTION 'migration 414: % linha(s) de users sem account_type', v_sem_tipo;
  END IF;
  RAISE NOTICE 'Migration 414: users.account_type criada, backfill fechado, trigger de ponte ativo.';
END;
$$;

COMMIT;
