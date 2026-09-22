-- 465 — `users.last_seen_at`: presença simples do painel admin (change
-- 022-ux-mencao-e-notificacao, Rodada 2/R2-B).
--
-- Decisão do Gabriel (22/09/2026): o painel admin ABERTO manda heartbeat a cada ~60s; o servidor
-- grava SÓ o último "visto por último" — sem histórico, sem log por heartbeat (`own_presence`,
-- não uma tabela de eventos). `isOnline` é DERIVADO na leitura (`now() - last_seen_at < 5 min`,
-- ver `AdminRepository.searchStaffDirectory`), nunca persistido.
--
-- NULL = nunca houve heartbeat desta conta (nunca abriu o painel com o cliente que manda
-- heartbeat, ou é conta antiga a que o backfill não se aplica — não há backfill: coluna nasce
-- vazia para todo mundo, coerente com "não sei" ≠ "offline há muito tempo").
--
-- Aditiva, idempotente (`ADD COLUMN IF NOT EXISTS`), sem backfill, sem `NOT NULL`, sem `DEFAULT`
-- — a migration mais barata possível: migrations rodam sozinhas no boot em prd (CLAUDE.md,
-- Regras duras > Produção).
--
-- Sem GRANT explícito: molde `414_users_account_type.sql` (mesma tabela, mesma operação —
-- `ALTER TABLE users ADD COLUMN`, sem GRANT). O privilégio da role de runtime é POR TABELA
-- (`269_app_runtime_roles.sql`: `GRANT SELECT, INSERT, UPDATE, DELETE ON <tabela> TO app_runtime,
-- app_system`, com `ALTER DEFAULT PRIVILEGES` cobrindo tabela NOVA — não coluna nova de tabela
-- existente); coluna nova de uma tabela já concedida herda o grant da tabela automaticamente, sem
-- precisar de um GRANT column-level (Postgres não tem GRANT por coluna para UPDATE/SELECT de
-- linha inteira, só para SELECT/UPDATE column-list explícita, que `users` não usa hoje).
--
-- Sem índice: o cálculo de `isOnline` roda sobre o resultado JÁ FILTRADO por
-- `account_type = 'staff' AND is_active = true` (que tem índice, `idx_users_is_active` da 003) e
-- limitado por `MAX_STAFF_DIRECTORY_RESULTS`/`limit` (máx. 200) — não é um WHERE de listagem larga
-- que precise de índice próprio.
--
-- ROLLBACK: `ALTER TABLE users DROP COLUMN IF EXISTS last_seen_at;`

BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN users.last_seen_at IS
  'Presença simples (change 022-ux-mencao-e-notificacao, R2): timestamp do último heartbeat do '
  'painel admin aberto (POST /api/admin/me/presence). NULL = nunca houve heartbeat. Cada '
  'heartbeat SOBRESCREVE — sem histórico, sem linha por chamada. Throttle no app: só regrava se '
  'o valor atual tiver mais de 30s (UpdatePresenceUseCase). isOnline (calculado na leitura, nunca '
  'persistido) = last_seen_at IS NOT NULL AND last_seen_at > now() - interval ''5 minutes''.';

COMMIT;
