-- 442 — Tabela companheira de PRESTADORES por paciente+mês do Ana Care (D361, `anacare-conferencia-de-horas`
-- fase-6.md, Adendo 17/09 — "o filtro de prestador, e o contrato da lista").
--
-- Por quê: o levantamento pós-F6.1 achou que a lista tem um filtro "Todos los prestadores"
-- (`AnaCareHoursListPage.tsx:66`) que precisa, por paciente, do CONJUNTO de prestadores COM NOME —
-- exatamente o que a D361 original tinha decidido parar de guardar (quem cuidou de quem). Decisão
-- do Gabriel (17/09): recuo PARCIAL e declarado — guarda o PAR paciente×prestador×mês, SEM dia nem
-- hora (~200 pares no mês contra as 2.700 linhas de turno de antes).
--
-- `providers_count` continua em `anacare_patient_month` (migration 441) — esta tabela não precisa
-- ser somada com JOIN para a contagem, só para os NOMES + o conjunto (dropdown do filtro).
--
-- Nome do prestador tem a MESMA regra do nome do paciente (441): vem dos DTOs em memória
-- (`anacare_shift` não tem coluna de nome), e o `ON CONFLICT` usa COALESCE — rodada sem nome
-- NUNCA apaga nome já gravado.
--
-- Convivência: mesma decisão da 441 — nasce ao lado de `anacare_shift`/`anacare_patient_month`,
-- populada pelo `AnaCareHoursSyncRunner` via `AnaCarePatientMonthRepository.recomputeFromShifts`.
--
-- Mesmo molde de 437/439/441: `country` texto com default, GRANT explícito por tabela (sem ALTER
-- DEFAULT PRIVILEGES), CHECK de `period_month` truncado ao 1º dia do mês. SEM RLS/política por
-- país — mesma decisão da 437/441.
--
-- Índice: a UNIQUE `(source, ana_care_patient_id, ana_care_nurse_id, period_month)` já cobre o
-- acesso pontual; um índice extra por `(source, period_month)` serve a leitura do mês inteiro
-- (F6.2, `AnaCareHoursService.getMonthSnapshot` monta o dropdown/filtro a partir daqui).
--
-- Rollback (par desta migration):
--   DROP TABLE IF EXISTS anacare_patient_month_provider;

BEGIN;

CREATE TABLE IF NOT EXISTS anacare_patient_month_provider (
  id                    BIGSERIAL    PRIMARY KEY,
  source                TEXT         NOT NULL DEFAULT 'anacare',
  ana_care_patient_id   TEXT         NOT NULL,
  ana_care_nurse_id     TEXT         NOT NULL,
  period_month          DATE         NOT NULL,
  nurse_first_name      TEXT         NULL,
  nurse_last_name       TEXT         NULL,
  country               TEXT         NOT NULL DEFAULT 'AR',
  fetched_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_anacare_patient_month_provider_source_patient_nurse_period
    UNIQUE (source, ana_care_patient_id, ana_care_nurse_id, period_month),
  CONSTRAINT chk_anacare_patient_month_provider_source CHECK (source ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT chk_anacare_patient_month_provider_period_month
    CHECK (period_month = date_trunc('month', period_month)::date)
);

-- Serve a leitura da LISTA do mês inteiro (F6.2, monta o conjunto de prestadores por paciente e o
-- dropdown do filtro) — a UNIQUE acima já cobre o acesso pontual por par.
CREATE INDEX IF NOT EXISTS idx_anacare_patient_month_provider_source_period
  ON anacare_patient_month_provider (source, period_month);

COMMENT ON TABLE anacare_patient_month_provider IS
  'Par paciente×prestador×mês do Ana Care (D361 Adendo 17/09, fase-6.md) — uma linha por '
  '(source, ana_care_patient_id, ana_care_nurse_id, period_month), escrita pelo '
  'AnaCareHoursSyncRunner ao lado de anacare_shift/anacare_patient_month. Recuo PARCIAL e '
  'declarado da D361: guarda QUEM cuidou de quem no mês, sem dia nem hora, porque o filtro '
  '"Todos los prestadores" da lista precisa do conjunto com nome.';

COMMENT ON COLUMN anacare_patient_month_provider.nurse_first_name IS
  'Primeiro valor NÃO-VAZIO de nome entre os turnos deste par paciente×prestador no mês (mesma '
  'regra de anacare_patient_month.patient_first_name) — vem do DTO em memória, nunca de '
  '`workers`/KMS.';

COMMENT ON COLUMN anacare_patient_month_provider.nurse_last_name IS
  'Ver nurse_first_name — mesmo critério (primeiro não-vazio).';

COMMENT ON COLUMN anacare_patient_month_provider.fetched_at IS
  'Carimbo do upsert mais recente — mesmo contrato de anacare_patient_month.fetched_at.';

-- GRANT explícito por tabela (convenção do repo — sem ALTER DEFAULT PRIVILEGES, molde 437/441).
GRANT SELECT, INSERT, UPDATE ON anacare_patient_month_provider TO app_runtime, app_system;
GRANT USAGE, SELECT ON SEQUENCE anacare_patient_month_provider_id_seq TO app_runtime, app_system;

COMMIT;
