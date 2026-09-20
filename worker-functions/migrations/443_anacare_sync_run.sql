-- 443 — Carimbo da corrida do sync do Ana Care passa a ser do SERVIDOR (gate `revisao-pr`, fecho
-- 17/09 — bloqueio "carimbo vindo do cliente").
--
-- Por quê: `runStartedAt` chegava no corpo HTTP (`syncTriggerBodySchema.runStartedAt`), vindo do
-- CLIENTE. Três buracos medidos pelo gate:
--   1. o Cloud Scheduler posta corpo fixo e não lê a resposta ⇒ na retomada real (`cursor`
--      não-nulo) o carimbo era sempre um `new Date()` novo desta invocação ⇒ a detecção de colisão
--      cross-invocação (`AnaCarePatientMonthRepository.upsertReplacingForRun`) ficava DESLIGADA em
--      produção, e a rota devolve HTTP 200 mesmo assim — falha silenciosa;
--   2. `z.string().datetime()` aceita qualquer data — uma no FUTURO desliga o detector inteiro (a
--      comparação `fetched_at >= runStartedAt` nunca bate), uma no PASSADO remoto faz qualquer
--      corrida antiga "colidir" com a atual;
--   3. o predicado comparava `fetched_at` (`NOW()` do Postgres) com um `Date` calculado no Node —
--      deriva de relógio entre os dois processos faz a colisão falhar em silêncio.
--
-- Desenho (decisão do Gabriel, 17/09): tabela nova, UMA linha por `(source, period_month)`, com
-- `run_started_at` gravado com `NOW()` DO BANCO — nunca um valor calculado no Node nem recebido do
-- cliente. `runStartedAt` SAI do schema de ENTRADA HTTP (`syncTriggerBodySchema`) — a rota não
-- aceita mais esse campo do chamador. Continua saindo na RESPOSTA (`AnaCareHoursSyncOutcome.runStartedAt`),
-- só para observabilidade (o script de medição loga o carimbo, não o reenvia).
--
-- Semântica de leitura/escrita (`AnaCareHoursSyncRunner.run`):
--   - trigger SEM cursor (corrida NOVA) ⇒ UPSERT: grava `run_started_at = NOW()` do banco,
--     substituindo qualquer carimbo de uma corrida anterior para o mesmo `(source, period_month)`;
--   - trigger COM cursor (retomada) ⇒ SELECT: lê o `run_started_at` já gravado. Se não houver linha
--     (corrida nunca registrada — ex.: banco resetado entre invocações), trata como corrida NOVA
--     (grava um carimbo próprio) e o runner RELATA essa decisão no log (nunca finge que existia uma
--     corrida anterior).
--
-- Mesmo molde de 437/441/442: `country` texto com default, GRANT explícito por tabela (sem ALTER
-- DEFAULT PRIVILEGES), CHECK de `period_month` truncado ao 1º dia do mês, UNIQUE
-- `(source, period_month)`. SEM FK para `patients` (as tabelas irmãs 441/442 também não têm — fora
-- do escopo deste conserto mudar isso). SEM RLS/política por país — mesma decisão da 437/441/442.
--
-- Rollback (par desta migration):
--   DROP TABLE IF EXISTS anacare_sync_run;

BEGIN;

CREATE TABLE IF NOT EXISTS anacare_sync_run (
  id                BIGSERIAL    PRIMARY KEY,
  source            TEXT         NOT NULL DEFAULT 'anacare',
  period_month      DATE         NOT NULL,
  run_started_at    TIMESTAMPTZ  NOT NULL,
  country           TEXT         NOT NULL DEFAULT 'AR',
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_anacare_sync_run_source_period UNIQUE (source, period_month),
  CONSTRAINT chk_anacare_sync_run_source CHECK (source ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT chk_anacare_sync_run_period_month
    CHECK (period_month = date_trunc('month', period_month)::date)
);

COMMENT ON TABLE anacare_sync_run IS
  'Carimbo do INÍCIO da corrida lógica de sync do Ana Care, gravado com NOW() do BANCO — nunca '
  'calculado no Node nem recebido do cliente HTTP (gate revisao-pr, fecho 17/09). Uma linha por '
  '(source, period_month): corrida NOVA (sem cursor) faz UPSERT do carimbo; retomada (com cursor) '
  'faz SELECT do carimbo já gravado. Alimenta o detector de colisão cross-invocação de '
  'AnaCarePatientMonthRepository.upsertReplacingForRun.';

COMMENT ON COLUMN anacare_sync_run.run_started_at IS
  'NOW() do Postgres no momento em que a corrida NOVA começou — mesma fonte de relógio de '
  'anacare_patient_month.fetched_at (também NOW() do banco), para a comparação '
  '`fetched_at >= run_started_at` nunca sofrer deriva entre processos.';

-- GRANT explícito por tabela (convenção do repo — sem ALTER DEFAULT PRIVILEGES, molde 437/441/442).
GRANT SELECT, INSERT, UPDATE ON anacare_sync_run TO app_runtime, app_system;
GRANT USAGE, SELECT ON SEQUENCE anacare_sync_run_id_seq TO app_runtime, app_system;

COMMIT;
