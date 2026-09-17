-- 441 — Retrato AGREGADO por paciente+mês do Ana Care (D361, `anacare-conferencia-de-horas`
-- fase-6.md, sub-fase F6.1).
--
-- Por quê: a D361 (17/09) decidiu que a LISTA não precisa mais do turno individual — o array
-- inteiro só existia porque `anacare_shift` (migration 437/439) é reescrita por turno e o
-- FRONTEND somava tudo na hora (`selectors.ts:36-73`). Guardar 145 pacientes×mês agregados é mais
-- barato e mais seguro (menos granularidade fina retida) do que continuar guardando 2.701+ linhas
-- de turno só para a lista somar de novo a cada leitura.
--
-- Convivência deliberada (F6.1): esta tabela nasce ao lado de `anacare_shift`, que continua sendo
-- escrita normalmente — a lista só passa a ler daqui na F6.2. `anacare_shift` sai inteira na F6.4.
--
-- O nome do paciente mora AQUI (`patient_first_name`/`patient_last_name`), não em cada turno —
-- resolve o que sobrou do #417 (145 linhas carregam o nome, não 2.701).
--
-- Duas colunas de hora, de propósito (fase-6.md §"A forma agregada"): a lista tem um alternador de
-- semântica — `totalHours(shifts, mode)` soma `hoursActual ?? (mode==='zero' ? 0 : hoursScheduled)`
-- (`selectors.ts:36-47`). `hours_actual_sum` cobre o modo `zero`; somada a
-- `hours_scheduled_sum_missing_actual` cobre o modo previsto. Colapsar em uma coluna mataria um
-- dos dois modos — não é normalização a fazer depois, é informação que se perde.
--
-- `providers_count`/`shifts_count`/`origin_*` são as mesmas colunas que a lista já mostra hoje
-- (`AnaCareOriginCounts`, `selectors.ts:67-73` do front, espelhado aqui por
-- `AnaCareHoursMapper.mapShift`: `origin = checkinSource === null ? 'sin_checkin' : checkinSource`).
--
-- Mesmo molde de `anacare_shift` (migration 437): `country` texto com default, GRANT explícito por
-- tabela (sem ALTER DEFAULT PRIVILEGES), CHECK de `period_month` truncado ao 1º dia do mês. SEM
-- RLS/política por país — mesma decisão da 437: fica para quando os dados REAIS entrarem sob
-- classificação de universo por agência (spec §isolamento por país), não é critério desta fase.
--
-- Índice: `(source, period_month)` serve a leitura da lista inteira do mês (F6.2,
-- `AnaCareHoursService.getMonthSnapshot`) — não precisa de índice por paciente isolado porque a
-- UNIQUE `(source, ana_care_patient_id, period_month)` já cobre esse acesso pontual.
--
-- Rollback (par desta migration):
--   DROP TABLE IF EXISTS anacare_patient_month;

BEGIN;

CREATE TABLE IF NOT EXISTS anacare_patient_month (
  id                                  BIGSERIAL    PRIMARY KEY,
  source                              TEXT         NOT NULL DEFAULT 'anacare',
  ana_care_patient_id                 TEXT         NOT NULL,
  period_month                        DATE         NOT NULL,
  patient_first_name                  TEXT         NULL,
  patient_last_name                   TEXT         NULL,
  providers_count                     INTEGER      NOT NULL DEFAULT 0,
  shifts_count                        INTEGER      NOT NULL DEFAULT 0,
  hours_actual_sum                    NUMERIC      NOT NULL DEFAULT 0,
  hours_scheduled_sum_missing_actual  NUMERIC      NOT NULL DEFAULT 0,
  origin_sin_checkin                  INTEGER      NOT NULL DEFAULT 0,
  origin_web_admin                    INTEGER      NOT NULL DEFAULT 0,
  origin_app                          INTEGER      NOT NULL DEFAULT 0,
  country                             TEXT         NOT NULL DEFAULT 'AR',
  fetched_at                          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at                          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at                          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_anacare_patient_month_source_patient_period
    UNIQUE (source, ana_care_patient_id, period_month),
  CONSTRAINT chk_anacare_patient_month_source CHECK (source ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT chk_anacare_patient_month_period_month
    CHECK (period_month = date_trunc('month', period_month)::date),
  CONSTRAINT chk_anacare_patient_month_providers_count CHECK (providers_count >= 0),
  CONSTRAINT chk_anacare_patient_month_shifts_count CHECK (shifts_count >= 0),
  CONSTRAINT chk_anacare_patient_month_hours_actual_sum CHECK (hours_actual_sum >= 0),
  CONSTRAINT chk_anacare_patient_month_hours_scheduled_sum CHECK (hours_scheduled_sum_missing_actual >= 0),
  CONSTRAINT chk_anacare_patient_month_origin_counts CHECK (
    origin_sin_checkin >= 0 AND origin_web_admin >= 0 AND origin_app >= 0
  )
);

-- Serve a leitura da LISTA do mês inteiro (F6.2) — a UNIQUE acima já cobre o acesso por paciente.
CREATE INDEX IF NOT EXISTS idx_anacare_patient_month_source_period
  ON anacare_patient_month (source, period_month);

COMMENT ON TABLE anacare_patient_month IS
  'Retrato AGREGADO por paciente+mês do Ana Care (D361, fase-6.md F6.1) — uma linha por '
  '(source, ana_care_patient_id, period_month), escrita pelo AnaCareHoursSyncRunner ao lado de '
  'anacare_shift (convivência deliberada até a F6.4). A lista lê daqui a partir da F6.2; o '
  'DETALHE nunca lê daqui — vai à fonte ao vivo (spec §Assimetria lista×detalhe).';

COMMENT ON COLUMN anacare_patient_month.patient_first_name IS
  'Primeiro valor NÃO-VAZIO de nome entre os turnos do paciente no mês (mesma regra de '
  'AnaCareHoursMapper.groupIntoPatients: o primeiro turno com nome vindo da fonte vence, os demais '
  'não sobrescrevem). Resolve o #417: o nome mora aqui (145 linhas), não em cada turno.';

COMMENT ON COLUMN anacare_patient_month.patient_last_name IS
  'Ver patient_first_name — mesmo critério (primeiro não-vazio).';

COMMENT ON COLUMN anacare_patient_month.hours_actual_sum IS
  'Soma das horas REAIS (checkin_at→checkout_at) só dos turnos que TÊM check-in E checkout. '
  'Cobre sozinha o modo `zero` de totalHours (selectors.ts:36-47 do front) — turno sem hora real '
  'soma 0, nunca é omitido.';

COMMENT ON COLUMN anacare_patient_month.hours_scheduled_sum_missing_actual IS
  'Soma do PREVISTO (scheduled_end - scheduled_start) só dos turnos que NÃO têm hora real. Somada '
  'a hours_actual_sum, cobre o modo "previsto" de totalHours — NUNCA some as duas para o modo '
  '`zero`, e nunca use isoladamente para o modo previsto (precisa somar hours_actual_sum).';

COMMENT ON COLUMN anacare_patient_month.origin_sin_checkin IS
  'Contagem de turnos com checkin_source NULL (AnaCareHoursMapper: origin = checkinSource === null '
  '? "sin_checkin" : checkinSource) — coluna "Origen check-in" da lista.';

COMMENT ON COLUMN anacare_patient_month.origin_web_admin IS 'Ver origin_sin_checkin.';
COMMENT ON COLUMN anacare_patient_month.origin_app IS 'Ver origin_sin_checkin.';

COMMENT ON COLUMN anacare_patient_month.fetched_at IS
  'Carimbo do upsert mais recente — alimenta getSnapshotFreshness (mesmo contrato do homônimo de '
  'AnaCareShiftRepository): contagem zero de linhas é FALHA (retrato nunca construído), nunca '
  'sucesso silencioso.';

-- GRANT explícito por tabela (convenção do repo — sem ALTER DEFAULT PRIVILEGES, molde 430/436/437).
GRANT SELECT, INSERT, UPDATE ON anacare_patient_month TO app_runtime, app_system;
GRANT USAGE, SELECT ON SEQUENCE anacare_patient_month_id_seq TO app_runtime, app_system;

COMMIT;
