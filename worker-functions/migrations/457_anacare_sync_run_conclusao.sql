-- 457 — Ana Care Horas: sinal de CONCLUSÃO de corrida na própria linha do mês (F1 da change
-- `anacare-horas-conclusao-de-corrida`, 20/09/2026).
--
-- POR QUÊ: o sync de horas do Ana Care roda como laço de paginação NO NAVEGADOR
-- (`enlite-frontend/src/hooks/admin/useAnaCareHoursSync.ts`), cursor só em `sessionStorage`.
-- Fechar a aba mata a corrida no meio e NADA do lado do servidor registra isso — `anacare_sync_run`
-- (migration 443) só guarda `run_started_at`. Agosto/2026 ficou em ~40% de cobertura de horas por
-- semanas sem ninguém perceber, porque não existe hoje nenhum sinal — nem banco, nem tela — de
-- corrida abandonada no meio. Esta migration não tira o laço do navegador (outra frente) nem muda
-- o que significa "mês publicado" (idem) — só dá ao SERVIDOR um jeito de enxergar o progresso que
-- o navegador já dirige.
--
-- O QUE FAZ: 6 colunas ADITIVAS em `anacare_sync_run`, todas NULLABLE e SEM DEFAULT — `NULL`
-- significa DESCONHECIDO, nunca "zero" e nunca "falhou". As linhas de agosto/setembro que já
-- existem ficam com `status IS NULL` depois desta migration, e ESSE é o comportamento CORRETO —
-- não é um defeito a corrigir, e por isso não há nenhum `UPDATE` de backfill aqui.
--
--   - status               TEXT        — 'running' | 'done' | 'failed' | NULL (CHECK abaixo aceita NULL)
--   - cursor               INTEGER     — palavra RESERVADA em SQL: toda referência entre aspas duplas
--   - reservations_total   INTEGER
--   - reservations_done    INTEGER
--   - finished_at          TIMESTAMPTZ
--   - last_error           TEXT        — código ESTÁVEL do erro, NUNCA a mensagem crua da exceção
--                                         (a mensagem pode carregar nome de paciente — PII não
--                                         entra em banco, Ley 25.326 / regra dura do CLAUDE.md do
--                                         ebrain). Ver `toStableErrorCode`,
--                                         `AnaCareSyncErrorCode.ts`.
--
-- QUEM ESCREVE: só `AnaCareHoursSyncController.trigger`, a cada rodada — nunca o runner (que não
-- tem acesso a banco hoje; mesma separação de camadas já existente no módulo). Uma linha por
-- `(source, period_month)` — a `UNIQUE (source, period_month)` de 443 NÃO muda: uma corrida nova
-- sobrescreve o progresso da anterior para o mesmo mês (histórico por corrida é outra frente, fora
-- de escopo desta change).
--
-- GRANT: `443_anacare_sync_run.sql` já concedeu `GRANT SELECT, INSERT, UPDATE ON anacare_sync_run
-- TO app_runtime, app_system` em nível de TABELA (nunca por coluna, mesma convenção do resto do
-- repo) — cobre as 6 colunas novas sem precisar reemitir nada aqui. Conferido, nada a acrescentar.
--
-- Rollback (par desta migration):
--   BEGIN;
--   ALTER TABLE anacare_sync_run
--     DROP COLUMN IF EXISTS status,
--     DROP COLUMN IF EXISTS "cursor",
--     DROP COLUMN IF EXISTS reservations_total,
--     DROP COLUMN IF EXISTS reservations_done,
--     DROP COLUMN IF EXISTS finished_at,
--     DROP COLUMN IF EXISTS last_error;
--   COMMIT;

BEGIN;

ALTER TABLE anacare_sync_run ADD COLUMN IF NOT EXISTS status TEXT NULL;
ALTER TABLE anacare_sync_run ADD COLUMN IF NOT EXISTS "cursor" INTEGER NULL;
ALTER TABLE anacare_sync_run ADD COLUMN IF NOT EXISTS reservations_total INTEGER NULL;
ALTER TABLE anacare_sync_run ADD COLUMN IF NOT EXISTS reservations_done INTEGER NULL;
ALTER TABLE anacare_sync_run ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ NULL;
ALTER TABLE anacare_sync_run ADD COLUMN IF NOT EXISTS last_error TEXT NULL;

ALTER TABLE anacare_sync_run
  ADD CONSTRAINT chk_anacare_sync_run_status
  CHECK (status IS NULL OR status IN ('running', 'done', 'failed'));

COMMENT ON COLUMN anacare_sync_run.status IS
  'Estado da corrida para este (source, period_month). NULL = DESCONHECIDO (nunca escrito por esta '
  'change — é o estado em que ficam as linhas de agosto/setembro pré-existentes, e isso é correto, '
  'não um defeito). running = em andamento, done = terminou a lista de reservas desta rodada, '
  'failed = o runner lançou. Gravado só pelo controller, a cada rodada — nunca pelo runner.';

COMMENT ON COLUMN anacare_sync_run."cursor" IS
  'Espelho do nextCursor da última rodada (AnaCareHoursSyncRunner.runOnce) — índice de retomada na '
  'lista ordenada de reservas. Nome reservado em SQL: sempre entre aspas duplas.';

COMMENT ON COLUMN anacare_sync_run.reservations_total IS
  'reservationIds.length da última rodada (AnaCareHoursSyncOutcome.reservationsTotal) — quantas '
  'reservas a lista tinha ao todo nesta rodada, não quantas esta rodada processou sozinha.';

COMMENT ON COLUMN anacare_sync_run.reservations_done IS
  'Índice absoluto `i` no momento em que a última rodada retornou (AnaCareHoursSyncOutcome.'
  'reservationsDone) — quanto da lista já foi percorrido ao todo, somando rodadas anteriores '
  'retomadas por cursor.';

COMMENT ON COLUMN anacare_sync_run.finished_at IS
  'NOW() do banco no momento em que status virou done ou failed. NULL enquanto running, e também '
  'NULL para as linhas pré-existentes (status IS NULL).';

COMMENT ON COLUMN anacare_sync_run.last_error IS
  'Código ESTÁVEL do erro (nome da classe + status HTTP quando houver, ex.: '
  '"AnaCarePatientMonthCollisionError:409") — NUNCA a mensagem crua da exceção, que pode carregar '
  'nome de paciente. Ver `toStableErrorCode`, `AnaCareSyncErrorCode.ts`.';

COMMIT;
