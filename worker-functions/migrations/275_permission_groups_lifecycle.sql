-- 275: ciclo de vida de grupos/membership/catálogo (change painel-grupos-permissao, D115)
--
-- POR QUÊ: o painel de grupos precisa ARQUIVAR (não apagar) grupo, REMOVER (não apagar)
-- membro e DESCONTINUAR (não apagar) célula do catálogo — o histórico sustenta
-- auditoria (quem entrou/saiu/quando, quem concedeu) e a extração futura. Hoje
-- `user_groups` tem PK (user_id, group_id) e remoção seria DELETE físico.
--
-- O QUE FAZ (idempotente):
--   1. iam.permission_groups: archived_at/archived_by (arquivado ≠ excluído).
--   2. iam.user_groups: removed_at/removed_by; a PK física dá lugar a índice ÚNICO
--      PARCIAL (WHERE removed_at IS NULL) — o mesmo par (user, grupo) pode ter N linhas
--      históricas e no máximo 1 viva. Como a PK atual é o próprio (user_id, group_id),
--      ela é dropada e substituída por PK sintética (id uuid) para preservar linhas.
--   3. iam.permissions: deprecated_at (célula que sumiu do código — scanner 2.3) e
--      owner_service (qual serviço declara — catálogo distribuído, D115).
--   4. iam.permission_group_changes: append-only da composição do grupo (célula
--      adicionada/removida, por quem, quando) — as roles do app só INSERT.
--   5. Corrige o comentário "43 permissões" da 206 (são 41).
--
-- Comportamento inalterado: nada lê essas colunas ainda; a policy 271/274 e o guard
-- só olham `revoked_at` do escopo — as funções da 276 é que passam a filtrar
-- archived/removed/deprecated.

-- ── 1. Grupo: arquivar ────────────────────────────────────────────────────────────
ALTER TABLE iam.permission_groups
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived_by VARCHAR(128) REFERENCES users(firebase_uid);
COMMENT ON COLUMN iam.permission_groups.archived_at IS
  'Arquivado (nunca DELETE): deixa de conceder e some das listas ativas; histórico fica.';

-- ── 2. Membership: soft-remove com histórico ───────────────────────────────────────
ALTER TABLE iam.user_groups
  ADD COLUMN IF NOT EXISTS id UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS removed_by VARCHAR(128) REFERENCES users(firebase_uid);

DO $$
BEGIN
  -- Troca a PK (user_id, group_id) pela sintética, uma vez só.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'iam.user_groups'::regclass AND contype = 'p'
      AND array_length(conkey, 1) = 2
  ) THEN
    ALTER TABLE iam.user_groups DROP CONSTRAINT user_groups_pkey;
    ALTER TABLE iam.user_groups ADD PRIMARY KEY (id);
  END IF;
END
$$;

-- No máximo 1 vínculo VIVO por (user, grupo); histórico ilimitado.
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_groups_live
  ON iam.user_groups (user_id, group_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_user_groups_user_live
  ON iam.user_groups (user_id) WHERE removed_at IS NULL;
COMMENT ON COLUMN iam.user_groups.removed_at IS
  'Removido (nunca DELETE): vínculo deixa de valer na próxima request; histórico fica.';

-- ── 3. Catálogo: descontinuar + dono ───────────────────────────────────────────────
ALTER TABLE iam.permissions
  ADD COLUMN IF NOT EXISTS deprecated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS owner_service VARCHAR(64) NOT NULL DEFAULT 'worker-functions';
COMMENT ON COLUMN iam.permissions.deprecated_at IS
  'Célula que deixou de ser declarada no código (scanner de catálogo). Não concede mais; '
  'não some do histórico dos grupos.';
COMMENT ON COLUMN iam.permissions.owner_service IS
  'Serviço que declara esta célula (catálogo distribuído — hoje só worker-functions).';
COMMENT ON TABLE iam.permissions IS
  'Catálogo recurso×ação. Semeado com 41 células na mig 206 (o comentário "43" da 206 '
  'estava errado); a partir da 275 é DERIVADO das declarações no código (scanner).';

-- ── 4. Trilha da composição do grupo (append-only) ────────────────────────────────
CREATE TABLE IF NOT EXISTS iam.permission_group_changes (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id      UUID         NOT NULL REFERENCES iam.permission_groups(id) ON DELETE CASCADE,
  permission_id UUID         NOT NULL REFERENCES iam.permissions(id),
  op            VARCHAR(8)   NOT NULL CHECK (op IN ('add', 'remove')),
  changed_by    VARCHAR(128) NOT NULL,
  changed_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  reason        TEXT
);
CREATE INDEX IF NOT EXISTS ix_permission_group_changes_group
  ON iam.permission_group_changes (group_id, changed_at DESC);
COMMENT ON TABLE iam.permission_group_changes IS
  'Append-only: célula adicionada/removida de um grupo, por quem, quando. Sem dado de titular.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON iam.permission_group_changes FROM app_runtime, app_system;
    -- INSERT/SELECT vêm do default privilege da 274; escrita real é por SECURITY DEFINER (279).
  END IF;
END
$$;
