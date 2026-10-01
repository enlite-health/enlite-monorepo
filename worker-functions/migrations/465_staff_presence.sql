-- 465 — `staff_presence`: presença simples do painel admin, em TABELA PRÓPRIA (change
-- 022-ux-mencao-e-notificacao, Rodada 2/R2-B, reescrita de 22/09/2026).
--
-- POR QUÊ NÃO `users.last_seen_at` (versão anterior deste arquivo, nunca chegou a `main` —
-- confirmado por `git log origin/main -- migrations/465_users_last_seen_at.sql` vazio antes desta
-- reescrita, então trocar de desenho aqui é seguro): `users` tem o trigger
-- `update_users_updated_at` (`003_create_users_base_table.sql`) que roda `BEFORE UPDATE ON users
-- FOR EACH ROW` e regrava `updated_at = now()` em QUALQUER UPDATE da linha — inclusive um UPDATE
-- que só toca `last_seen_at`. Um heartbeat a cada ~60s por staff logado reescreveria
-- `users.updated_at` na mesma cadência, contaminando um campo de auditoria (`updated_at` deveria
-- significar "a FICHA do usuário mudou", não "abriu o painel") e qualquer coisa que ordene/filtre
-- por ele (auditoria, sync, cache invalidation). Tabela própria isola o heartbeat de `users` por
-- completo: o UPDATE/INSERT do heartbeat nunca toca a tabela `users`, então o trigger dela nunca
-- dispara por causa de presença.
--
-- Decisão do Gabriel (22/09/2026, mantida): o painel admin ABERTO manda heartbeat a cada ~60s; o
-- servidor grava só o último "visto por último" — sem histórico, sem log por heartbeat
-- (`staff_presence` guarda 1 linha por staff, nunca uma tabela de eventos). `isOnline` é DERIVADO
-- na leitura (`now() - last_seen_at < 5 min`, ver `AdminRepository.searchStaffDirectory`), nunca
-- persistido.
--
-- Ausência de linha (nunca `NULL` numa coluna) = nunca houve heartbeat desta conta (nunca abriu o
-- painel com o cliente que manda heartbeat, ou é conta antiga a que o backfill não se aplica — não
-- há backfill: a tabela nasce vazia para todo mundo, coerente com "não sei" ≠ "offline há muito
-- tempo"). `last_seen_at NOT NULL` porque a linha só existe a partir do 1º heartbeat — sem estado
-- "linha existe mas nunca teve heartbeat" para representar.
--
-- Aditiva, idempotente (`CREATE TABLE IF NOT EXISTS`), sem backfill — a migration mais barata
-- possível: migrations rodam sozinhas no boot em prd (CLAUDE.md, Regras duras > Produção).
--
-- GRANT: padrão copiado das migrations recentes de tabela NOVA (458/459/460/461 — `GRANT SELECT,
-- INSERT, UPDATE ON <tabela> TO app_runtime, app_system`, não `enlite_app`; a role de runtime deste
-- schema é `app_runtime`/`app_system`, grep feito nas migrations 458-461 antes de escrever esta).
-- Sem DELETE — heartbeat nunca apaga linha (o registro morre com o `ON DELETE CASCADE` do
-- `firebase_uid`, quando a conta é removida).
--
-- Sem RLS: `users` (a tabela-mãe) não tem RLS habilitada (grep confirmado) — presença não carrega
-- dado de país/tenant próprio, seria RLS sem política real para aplicar (mesma postura do pai).
--
-- Sem índice além do PK: o cálculo de `isOnline` roda por LEFT JOIN a partir de `users` já
-- filtrado por `account_type = 'staff' AND is_active = true` (índice `idx_users_is_active`, mig
-- 003) e limitado por `limit` (máx. 200) — não há WHERE largo sobre `staff_presence` que precise
-- de índice próprio; o PK em `firebase_uid` já serve o JOIN.
--
-- ROLLBACK: `DROP TABLE IF EXISTS staff_presence;`

BEGIN;

CREATE TABLE IF NOT EXISTS staff_presence (
  firebase_uid varchar(128) PRIMARY KEY REFERENCES users(firebase_uid) ON DELETE CASCADE,
  last_seen_at timestamptz NOT NULL
);

COMMENT ON TABLE staff_presence IS
  'Presença simples (change 022-ux-mencao-e-notificacao, R2, reescrita 22/09): 1 linha por staff '
  'que já mandou heartbeat do painel admin (POST /api/admin/me/presence). Ausência de linha = '
  'nunca houve heartbeat. Cada heartbeat SOBRESCREVE last_seen_at — sem histórico, sem linha por '
  'chamada. Throttle no SQL do UPSERT (WHERE no ON CONFLICT): só regrava se o valor atual tiver '
  'mais de 30s. Tabela PRÓPRIA (não coluna em users) para o heartbeat NUNCA disparar o trigger '
  'update_users_updated_at de users. isOnline (calculado na leitura, nunca persistido) = '
  'now() - last_seen_at < interval ''5 minutes''.';

GRANT SELECT, INSERT, UPDATE ON staff_presence TO app_runtime, app_system;

COMMIT;
