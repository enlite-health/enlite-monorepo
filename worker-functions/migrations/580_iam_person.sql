-- 580: iam.person + iam.person_login — a PESSOA como dono da identidade (spec acesso-do-cliente, F1, D647/D648)
--
-- POR QUÊ: 118 pessoas já têm dois uids reais vivos (vínculo de conta self-service) e 11 dos 20 staff
-- também são prestadores. Com o uid como chave, os vínculos de área (580+1: iam.area_membership) ficariam
-- divididos entre os logins. A pessoa é um id interno estável (`pid`, papel do `oid`); o login é uma
-- relação; o merge é por PONTEIRO (`merged_into_id`), nunca regravando linha de login nem de vínculo.
--
-- DONO ÚNICO (D514): `iam.person_login(provider, uid).person_id` responde "a quem pertence este login" —
-- só ele. `workers.auth_uid` segue dono de "qual login opera esta ficha" e `users.firebase_uid` de
-- "conta de funcionário". NENHUMA coluna nova em `users` nem em `workers`: "a pessoa desta ficha" é
-- derivada (`iam.resolve_person('firebase', workers.auth_uid)`), nunca gravada.
--
-- ESCRITA SÓ POR FUNÇÃO SECURITY DEFINER (mig 279: "a role confinada não forja o próprio grant"):
-- o schema `iam` ainda tem o privilégio PADRÃO de tabela futura (SELECT, INSERT, UPDATE, DELETE) para
-- app_runtime/app_system (274:141-143, LISTA 19; medido em evidencias/f1-grants-runtime.md §3), então uma
-- tabela nova NASCE com escrita aberta. Esta migration REVOGA INSERT/UPDATE/DELETE (+ TRUNCATE,
-- REFERENCES, TRIGGER) nas duas tabelas na mesma migration e concede SELECT EXPLÍCITO. Nada de
-- alteração de privilégio padrão aqui (a 324 revogou a herança de outro schema pelo mesmo motivo).
--
-- ⚠️ A migration roda como `enlite_app` (dono em prd, LOGIN sem superuser): só cria objetos próprios e
-- REVOKE/GRANT em objeto que ela mesma criou — nada de REVOKE no dono (551, deploy falhou em 30/10).
--
-- AJUSTES da T101 (evidencias/f1-vereditos.md §1.3) refletidos aqui:
--   A2: `remove_login` recebe o ator por PARÂMETRO (design §2.2), exceção declarada à regra da 279
--       ("o ATOR vem de app.user_uid, nunca de parâmetro"): quem chama é o caso de uso de exclusão
--       de conta, que não carrega o GUC de staff. O ator só é validado (não vazio) aqui; quem o
--       grava como `revoked_by` é a revogação do registro de vínculos (580+1).
--   A3: `merge_person`/`unmerge_person` CONFEREM no banco o fato que dizem registrar (a ficha absorvida
--       aponta para a sobrevivente / o audit existe), na mesma transação do gancho. Sem isso a role de
--       runtime uniria árvores à vontade.
--   A5: a lista de prefixos "sintéticos" daqui é a de `SYNTHETIC_AUTH_UID_PREFIXES` (6, incl. `talentum_`),
--       DE PROPÓSITO diferente de `isImportedWorker` do claim (5, sem `talentum_`): sintético = "não é
--       login real"; importável = "pode ser reclamado". A paridade é testada (syntheticPrefixesParity.test.ts).
-- Rollback: migrations/pending/ROLLBACK_580_iam_person.sql (DROP — só válido antes de 580+1 existir).

-- ── 1. Tabelas ──────────────────────────────────────────────────────────────────────
CREATE TABLE iam.person (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  merged_into_id   UUID        REFERENCES iam.person(id),
  merged_at        TIMESTAMPTZ,
  merged_by_worker_merge_audit_id BIGINT,
  CONSTRAINT person_not_self_merged CHECK (merged_into_id IS NULL OR merged_into_id <> id),
  CONSTRAINT person_merge_complete  CHECK ((merged_into_id IS NULL) = (merged_at IS NULL)),
  CONSTRAINT person_merge_ref_needs_merge CHECK (merged_by_worker_merge_audit_id IS NULL OR merged_into_id IS NOT NULL)
);

COMMENT ON TABLE iam.person IS
  'Pessoa = humano conhecido pela identidade (D647). Nunca apagada. Escrita só por função SECURITY DEFINER.';
COMMENT ON COLUMN iam.person.merged_into_id IS
  'NULL = pessoa NÃO foi absorvida (único significado). Preenchido = absorvida por essa pessoa (merge por ponteiro, D648).';
COMMENT ON COLUMN iam.person.merged_at IS
  'Quando foi absorvida. NULL exatamente quando merged_into_id é NULL (CHECK person_merge_complete).';
COMMENT ON COLUMN iam.person.merged_by_worker_merge_audit_id IS
  'Causa do merge (public.worker_merge_audit.id), SEM FK: o iam é extraível (D115). NULL com merged_into_id preenchido = merge sem registro de origem, sem desfazer possível.';

CREATE TABLE iam.person_login (
  provider        TEXT        NOT NULL CHECK (provider = 'firebase'),
  uid             TEXT        NOT NULL CHECK (length(uid) > 0),
  person_id       UUID        NOT NULL REFERENCES iam.person(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at      TIMESTAMPTZ,
  removed_reason  TEXT,
  PRIMARY KEY (provider, uid),
  CONSTRAINT person_login_removal_complete CHECK (
    (removed_at IS NULL AND removed_reason IS NULL) OR
    (removed_at IS NOT NULL AND removed_reason IS NOT NULL AND removed_reason = 'account_deleted'))  -- IS NOT NULL explícito: CHECK com NULL passa
);

COMMENT ON TABLE iam.person_login IS
  'A quem pertence cada login. PK (provider, uid) sobre TODAS as linhas, inclusive removidas: uid nunca é reatribuído (OIDC Core 5.7). Nunca guarda uid sintético.';
COMMENT ON COLUMN iam.person_login.person_id IS
  'IMUTÁVEL (trigger): a pessoa a que o login pertence = o claim pid do token. Não sobe a cadeia de merge.';
COMMENT ON COLUMN iam.person_login.removed_at IS
  'NULL = login vivo (único significado). Preenchido = conta apagada (removed_reason = account_deleted); a linha fica para a trilha.';

-- ── 2. Triggers (append-only, imutabilidade, anti-ciclo) ────────────────────────────
CREATE FUNCTION iam._person_no_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, iam, public
AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23000',
    MESSAGE = format('[iam] %s.%s é append-only: DELETE recusado (pessoa e login nunca são apagados)', TG_TABLE_SCHEMA, TG_TABLE_NAME);
END;
$$;

CREATE FUNCTION iam._person_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, iam, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.merged_into_id IS NOT NULL OR NEW.merged_at IS NOT NULL OR NEW.merged_by_worker_merge_audit_id IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = '[iam] pessoa nasce não absorvida: merged_* só muda por iam.merge_person';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE: só merged_* muda (id e created_at são imutáveis)
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = '[iam] iam.person: id e created_at são imutáveis';
  END IF;
  -- re-apontar direto de uma raiz para outra não é operação (desfaz e refaz): evita pular o undo
  IF OLD.merged_into_id IS NOT NULL AND NEW.merged_into_id IS NOT NULL
     AND NEW.merged_into_id IS DISTINCT FROM OLD.merged_into_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = '[iam] iam.person: pessoa absorvida não é re-apontada (desfaça o merge antes)';
  END IF;
  -- ciclo: subir a partir do novo alvo não pode chegar nesta pessoa (auto-merge cai no CHECK)
  IF NEW.merged_into_id IS NOT NULL AND NEW.merged_into_id <> NEW.id AND OLD.merged_into_id IS NULL THEN
    IF EXISTS (
      WITH RECURSIVE up AS (
        SELECT id, merged_into_id FROM iam.person WHERE id = NEW.merged_into_id
        UNION
        SELECT p.id, p.merged_into_id FROM iam.person p JOIN up ON p.id = up.merged_into_id
      )
      SELECT 1 FROM up WHERE id = NEW.id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = '[iam] iam.person: ciclo na cadeia de merge recusado';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION iam._person_login_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, iam, public
AS $$
BEGIN
  IF NEW.provider IS DISTINCT FROM OLD.provider OR NEW.uid IS DISTINCT FROM OLD.uid
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = '[iam] iam.person_login: provider, uid e created_at são imutáveis';
  END IF;
  IF NEW.person_id IS DISTINCT FROM OLD.person_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = '[iam] iam.person_login: person_id é imutável (o login não troca de pessoa)';
  END IF;
  -- removed_* só é preenchido UMA vez
  IF OLD.removed_at IS NOT NULL
     AND (NEW.removed_at IS DISTINCT FROM OLD.removed_at OR NEW.removed_reason IS DISTINCT FROM OLD.removed_reason) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = '[iam] iam.person_login: removed_* é preenchido uma única vez';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER person_no_delete BEFORE DELETE ON iam.person
  FOR EACH ROW EXECUTE FUNCTION iam._person_no_delete();
CREATE TRIGGER person_login_no_delete BEFORE DELETE ON iam.person_login
  FOR EACH ROW EXECUTE FUNCTION iam._person_no_delete();
CREATE TRIGGER person_guard BEFORE INSERT OR UPDATE ON iam.person
  FOR EACH ROW EXECUTE FUNCTION iam._person_guard();
CREATE TRIGGER person_login_guard BEFORE UPDATE ON iam.person_login
  FOR EACH ROW EXECUTE FUNCTION iam._person_login_guard();

-- ── 3. Privilégios das tabelas: leitura explícita, escrita NUNCA direta (LISTA 19) ──
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_system') THEN
    -- o default do schema iam (274) concede SELECT/INSERT/UPDATE/DELETE: fecha a escrita AQUI
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
      ON iam.person, iam.person_login FROM app_runtime, app_system;
    GRANT SELECT ON iam.person, iam.person_login TO app_runtime, app_system;
  END IF;
END $$;

-- ── 4. Funções ──────────────────────────────────────────────────────────────────────
-- 4.1 Lista de prefixos sintéticos: LITERAL CONGELADA (migration é ato único; vale a lista do dia).
--     É a ÚNICA cópia no banco (o backfill e o gancho a usam); sem CHECK de prefixo nas tabelas.
--     Paridade com SYNTHETIC_AUTH_UID_PREFIXES: syntheticPrefixesParity.test.ts.
CREATE FUNCTION iam._is_synthetic_uid(p_uid TEXT)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, iam, public
AS $$
  SELECT p_uid IS NULL OR p_uid = '' OR EXISTS (
    SELECT 1
    FROM unnest(ARRAY[
      'anacareimport_',
      'candidatoimport_',
      'pretalnimport_',
      'base1import_',
      'clickup_encuadre_',
      'talentum_'
    ]) AS prefix
    WHERE starts_with(p_uid, prefix)
  );
$$;

-- 4.2 Leitura (SECURITY DEFINER: o domínio não faz join em iam.*, consome por função)
CREATE FUNCTION iam.resolve_person(p_provider TEXT, p_uid TEXT)
RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, iam, public
AS $$
  SELECT l.person_id FROM iam.person_login l
  WHERE l.provider = p_provider AND l.uid = p_uid AND l.removed_at IS NULL;
$$;

CREATE FUNCTION iam.person_root(p_person_id UUID)
RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, iam, public
AS $$
  WITH RECURSIVE up AS (
    SELECT id, merged_into_id, 0 AS depth FROM iam.person WHERE id = p_person_id
    UNION ALL
    SELECT p.id, p.merged_into_id, up.depth + 1 FROM iam.person p JOIN up ON p.id = up.merged_into_id
    WHERE up.depth < 1000
  )
  SELECT id FROM up WHERE merged_into_id IS NULL;
$$;

CREATE FUNCTION iam.person_tree(p_person_id UUID)
RETURNS SETOF UUID
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, iam, public
AS $$
  WITH RECURSIVE down AS (
    SELECT iam.person_root(p_person_id) AS id, 0 AS depth
    UNION ALL
    SELECT c.id, down.depth + 1 FROM iam.person c JOIN down ON c.merged_into_id = down.id
    WHERE down.depth < 1000
  )
  SELECT id FROM down WHERE id IS NOT NULL;
$$;

CREATE FUNCTION iam.person_login_uids(p_person_id UUID)
RETURNS SETOF TEXT
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, iam, public
AS $$
  SELECT l.uid FROM iam.person_login l
  WHERE l.person_id IN (SELECT iam.person_tree(p_person_id))
    AND l.removed_at IS NULL
  ORDER BY l.uid;
$$;

-- 4.3 Bootstrap: login vivo → a pessoa DO LOGIN (o pid); inexistente → cria pessoa + login;
--     removido → NULL (conta apagada não ressuscita). Concorrência: lock por (provider, uid) até o fim da
--     transação — sem ele dois bootstraps criariam duas pessoas e uma ficaria órfã (DELETE é recusado).
CREATE FUNCTION iam.ensure_person(p_provider TEXT, p_uid TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, iam, public
AS $$
DECLARE
  v_person UUID;
  v_removed TIMESTAMPTZ;
  v_found BOOLEAN;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('iam:ensure_person:' || coalesce(p_provider, '') || ':' || coalesce(p_uid, '')));
  SELECT l.person_id, l.removed_at, true INTO v_person, v_removed, v_found
  FROM iam.person_login l WHERE l.provider = p_provider AND l.uid = p_uid;
  IF v_found THEN
    IF v_removed IS NOT NULL THEN
      RETURN NULL;
    END IF;
    RETURN v_person;
  END IF;
  INSERT INTO iam.person DEFAULT VALUES RETURNING id INTO v_person;
  INSERT INTO iam.person_login (provider, uid, person_id) VALUES (p_provider, p_uid, v_person);
  RETURN v_person;
END;
$$;

-- 4.4 Núcleo do merge, SEM o gate (compartilhado pelo gancho e pelo backfill; não é concedido a ninguém):
--     sintético/vazio → nada; ensure dos dois; raízes iguais → nada; senão raiz absorvida → raiz sobrevivente.
CREATE FUNCTION iam._merge_roots(p_absorbed_uid TEXT, p_survivor_uid TEXT, p_audit_id BIGINT, p_at TIMESTAMPTZ)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = pg_catalog, iam, public
AS $$
DECLARE
  v_pa UUID;
  v_ps UUID;
  v_ra UUID;
  v_rs UUID;
BEGIN
  IF iam._is_synthetic_uid(p_absorbed_uid) OR iam._is_synthetic_uid(p_survivor_uid) THEN
    RETURN;  -- não há login a unir (ficha sintética não é login)
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('iam:merge_person'));  -- serializa merges: raízes estáveis, sem ciclo
  v_pa := iam.ensure_person('firebase', p_absorbed_uid);
  v_ps := iam.ensure_person('firebase', p_survivor_uid);
  IF v_pa IS NULL OR v_ps IS NULL THEN
    RETURN;  -- login de conta apagada não é unido
  END IF;
  v_ra := iam.person_root(v_pa);
  v_rs := iam.person_root(v_ps);
  IF v_ra IS NULL OR v_rs IS NULL OR v_ra = v_rs THEN
    RETURN;
  END IF;
  UPDATE iam.person
     SET merged_into_id = v_rs,
         merged_at = p_at,
         merged_by_worker_merge_audit_id = p_audit_id
   WHERE id = v_ra;
END;
$$;

-- 4.5 Gancho do merge (chamado dentro da transação de merge de workers, depois do UPDATE de workers.merged_into_id).
--     A3: confere no banco que a ficha absorvida aponta para a sobrevivente — a role de runtime não une árvores à vontade.
CREATE FUNCTION iam.merge_person(p_absorbed_uid TEXT, p_survivor_uid TEXT, p_worker_merge_audit_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, iam, public
AS $$
BEGIN
  IF iam._is_synthetic_uid(p_absorbed_uid) OR iam._is_synthetic_uid(p_survivor_uid) THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.workers a
    JOIN public.workers s ON s.id = a.merged_into_id
    WHERE a.auth_uid = p_absorbed_uid AND s.auth_uid = p_survivor_uid
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = '[iam] merge_person recusado: a ficha do uid absorvido não aponta para a ficha do uid sobrevivente (workers.merged_into_id)';
  END IF;
  PERFORM iam._merge_roots(p_absorbed_uid, p_survivor_uid, p_worker_merge_audit_id, now());
END;
$$;

-- 4.6 Gancho do undo: limpa o ponteiro das pessoas absorvidas por AQUELE merge (cada pessoa fica com as próprias linhas).
--     A3: o audit tem de existir.
CREATE FUNCTION iam.unmerge_person(p_worker_merge_audit_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, iam, public
AS $$
BEGIN
  IF p_worker_merge_audit_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.worker_merge_audit m WHERE m.id = p_worker_merge_audit_id) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = '[iam] unmerge_person recusado: worker_merge_audit inexistente';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('iam:merge_person'));
  UPDATE iam.person
     SET merged_into_id = NULL, merged_at = NULL, merged_by_worker_merge_audit_id = NULL
   WHERE merged_by_worker_merge_audit_id = p_worker_merge_audit_id;
END;
$$;

-- 4.7 Conta apagada: preenche removed_* UMA vez (login inexistente ou já removido → nada).
--     O ator vem por parâmetro (A2, exceção declarada no cabeçalho). Revogar os vínculos da pessoa quando a árvore
--     fica sem login vivo é da migration do registro de vínculos (580+1), que redefine esta função (mesma assinatura).
CREATE FUNCTION iam.remove_login(p_provider TEXT, p_uid TEXT, p_actor_uid TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, iam, public
AS $$
BEGIN
  IF p_actor_uid IS NULL OR length(trim(p_actor_uid)) = 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '[iam] remove_login exige o ator (p_actor_uid)';
  END IF;
  UPDATE iam.person_login
     SET removed_at = now(), removed_reason = 'account_deleted'
   WHERE provider = p_provider AND uid = p_uid AND removed_at IS NULL;
END;
$$;

-- ── 5. GRANT EXECUTE explícito (nunca PUBLIC) ───────────────────────────────────────
REVOKE ALL ON FUNCTION
  iam._person_no_delete(), iam._person_guard(), iam._person_login_guard(),
  iam._is_synthetic_uid(TEXT), iam._merge_roots(TEXT, TEXT, BIGINT, TIMESTAMPTZ),
  iam.ensure_person(TEXT, TEXT), iam.resolve_person(TEXT, TEXT), iam.person_root(UUID),
  iam.person_tree(UUID), iam.person_login_uids(UUID), iam.merge_person(TEXT, TEXT, BIGINT),
  iam.unmerge_person(BIGINT), iam.remove_login(TEXT, TEXT, TEXT)
FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_system') THEN
    GRANT EXECUTE ON FUNCTION
      iam.ensure_person(TEXT, TEXT), iam.resolve_person(TEXT, TEXT), iam.person_root(UUID),
      iam.person_tree(UUID), iam.person_login_uids(UUID), iam.merge_person(TEXT, TEXT, BIGINT),
      iam.unmerge_person(BIGINT), iam.remove_login(TEXT, TEXT, TEXT)
    TO app_runtime, app_system;
  END IF;
END $$;

-- ── 6. Backfill (idempotente; também chamável de novo por teste) ────────────────────
-- (1) uma pessoa + um login por uid DISTINTO de users.firebase_uid ∪ workers.auth_uid não sintético
--     (toda ficha, inclusive absorvida e com deleted_at: o login existe até prova de que foi apagado).
--     users ∩ workers (11 em prd) vira UM login, UMA pessoa.
-- (2) para cada ficha A com merged_into_id = P (pai direto), uid real e diferente nos dois lados → mesma regra do
--     gancho (raiz absorvida → raiz sobrevivente), aresta a aresta, na ordem em que os merges ocorreram, com
--     merged_by_worker_merge_audit_id = o audit mais recente do par com undone_at IS NULL (sem audit → NULL = sem desfazer).
CREATE FUNCTION iam._backfill_person()
RETURNS VOID
LANGUAGE plpgsql
SET search_path = pg_catalog, iam, public
AS $$
DECLARE
  v_edge RECORD;
BEGIN
  CREATE TEMP TABLE _iam_backfill_new (uid TEXT PRIMARY KEY, pid UUID NOT NULL DEFAULT gen_random_uuid()) ON COMMIT DROP;
  INSERT INTO _iam_backfill_new (uid)
  SELECT u.uid
  FROM (
    SELECT firebase_uid AS uid FROM public.users
    UNION
    SELECT auth_uid FROM public.workers
  ) u
  WHERE NOT iam._is_synthetic_uid(u.uid)
    AND NOT EXISTS (SELECT 1 FROM iam.person_login l WHERE l.provider = 'firebase' AND l.uid = u.uid);
  INSERT INTO iam.person (id) SELECT pid FROM _iam_backfill_new;
  INSERT INTO iam.person_login (provider, uid, person_id) SELECT 'firebase', uid, pid FROM _iam_backfill_new;
  DROP TABLE _iam_backfill_new;

  FOR v_edge IN
    SELECT a.auth_uid AS absorbed_uid,
           p.auth_uid AS survivor_uid,
           m.id AS audit_id,
           coalesce(m.created_at, a.updated_at, now()) AS merged_at
    FROM public.workers a
    JOIN public.workers p ON p.id = a.merged_into_id
    LEFT JOIN LATERAL (
      SELECT wm.id, wm.created_at FROM public.worker_merge_audit wm
      WHERE wm.absorbed_id = a.id AND wm.survivor_id = p.id AND wm.undone_at IS NULL
      ORDER BY wm.id DESC LIMIT 1
    ) m ON true
    WHERE NOT iam._is_synthetic_uid(a.auth_uid)
      AND NOT iam._is_synthetic_uid(p.auth_uid)
      AND a.auth_uid <> p.auth_uid
    ORDER BY coalesce(m.created_at, a.updated_at, now()), a.id
  LOOP
    PERFORM iam._merge_roots(v_edge.absorbed_uid, v_edge.survivor_uid, v_edge.audit_id, v_edge.merged_at);
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION iam._backfill_person() FROM PUBLIC;

SELECT iam._backfill_person();
