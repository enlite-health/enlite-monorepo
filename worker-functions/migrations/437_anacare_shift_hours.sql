-- 437 — Conferência de horas do Ana Care (spec `anacare-conferencia-de-horas`, fase 1, D342-D345).
--
-- Divergência `main`×`stage` resolvida em favor da `stage` (19/09/2026, sync `main`→`stage`):
-- o `main` portou este arquivo removendo os GRANT explícitos (rodava só com a role única
-- `enlite_app`, dona por criação). A `stage` mantém os GRANT para `app_runtime`/`app_system`
-- porque, após a promoção desta migration para o `main`/prod, esses roles vão existir lá também
-- (modelo de privilégio separado já em curso) — manter os GRANT aqui evita reabrir esta migration
-- depois. Ver `## (A2)` do relatório de renumeração de 19/09 para a ação pendente em prd (aplicar
-- os GRANT à parte quando os roles existirem, já que esta migration, na versão do `main`, já rodou
-- em produção sem eles).
--
-- Colisão de PREFIXO com o `main` mantida DE PROPÓSITO (D. Gabriel/Marcel, 19/09/2026): o `main`
-- já tem, aplicadas em produção, `438_patient_source_snapshots.sql`, `439_patient_identity_links.sql`,
-- `441_patient_field_provenance.sql` e `442_patients_ana_care_id.sql` — números que a `stage`
-- também usa, para arquivos DIFERENTES. NÃO foram renumerados: o runner (`run-migrations-docker.js`,
-- rodado a cada boot em stage e prd — `worker-functions/Dockerfile:31`) chaveia migrations
-- aplicadas pelo NOME COMPLETO do arquivo (`schema_migrations.filename TEXT PRIMARY KEY`,
-- `worker-functions/scripts/run-migrations-docker.js:105-106`), não pelo prefixo numérico — dois
-- arquivos com o mesmo número e nomes diferentes não colidem de chave. A ORDEM de aplicação usa o
-- prefixo (`run-migrations-docker.js:23-28`) e, em empate de número, desempata por comparação crua
-- de string do nome completo — determinística, sem `localeCompare`. Medido: nenhum script/CI deste
-- repo resolve migration por número isolado (só por caminho completo), e o conteúdo das 4 migrations
-- do `main` (`patient_source_snapshots`/`patient_identity_links`/`patient_field_provenance`/
-- `patients_ana_care_id`) não tem FK nem dependência com as tabelas `anacare_*` da `stage` — os dois
-- conjuntos são independentes. Renumerar custaria mexer em 28+ arquivos (as migrations 443-446, mais
-- referenciadas por módulos posteriores) e reexecutar as migrations já aplicadas na stage, para
-- comprar só estética de numeração. Não renumerado.
--
-- Duas tabelas com DONOS diferentes (revisão do type-design-analyzer, 15/09,
-- `docs/funcionalidades/ana-care/proposta-schema-validacao-horas.md`):
--   1. `anacare_shift` — RETRATO operacional do turno, reescrito toda noite pelo job de sincronização
--      real (fases 2/4, hoje sob PARE do lex, D344). Nesta migration a tabela nasce VAZIA — a fase 1
--      lê os turnos da fonte pela porta `AnaCareShiftsSource` com o adapter FALSO (massa sintética,
--      em memória, nunca grava aqui). Existe já para não reabrir o desenho quando o job real entrar.
--   2. `shift_hours_validation` — o OK da operadora, ESTADO NOSSO, durável, NUNCA apagado pelo job.
--      Religa ao turno pela chave estável `(source, source_shift_id)` — nunca por FK ao id interno
--      do retrato (a retenção curta do retrato faria CASCADE apagar a validação).
--
-- Must-fix da revisão de abstração (todos aplicados aqui):
--   - `status` texto + CHECK IN ('pendente','validado','contestado').
--   - Validação snapshotar `ana_care_patient_id`/`ana_care_nurse_id` (IDS, não nomes — menos PII
--     permanente; sem isso, um retrato purgado deixa o OK sem saber de quem era, spec §Retrato de
--     turnos separado da validação).
--   - `validado` ⇒ `approved_hours`+`validated_by`+`validated_at` NOT NULL; `contestado` ⇒ `reason`
--     NOT NULL (D344 revoga em parte a proposta original: o motivo é de LISTA FECHADA, a nota em
--     texto livre é OPCIONAL); `pendente` ⇒ nada congelado — tudo via CHECK.
--   - `period_month = date_trunc('month', period_month)` via CHECK (sempre o 1º dia do mês).
--   - FK real em `validated_by` → `users(firebase_uid)` (users não tem `id` UUID — PK é o
--     firebase_uid, ver `migrations/003_create_users_base_table.sql`).
--   - Índices `(period_month, patient_id)`/`(period_month, worker_id)` no retrato, para quando o
--     job real (fase 2/4) o popular.
--   - TRIGGER de imutabilidade: `status='validado'` não permite alterar `status`/`approved_*`, só
--     `note_encrypted` (a nota é o único campo mutável pós-validação — spec §Condições do parecer
--     do lex, cenário "edição da nota depois de validado", ainda que a auditoria da edição seja
--     backlog D345). Transições permitidas: pendente→validado, pendente→contestado,
--     contestado→validado (nunca reabre um validado).
--
-- Decisão do Gabriel (15/09): SEM `patient_name_cache`/`nurse_name_cache` no retrato — nome só via
-- vínculo (`patients`/`workers`), nunca duplicado aqui.
--
-- D344: motivo de contestação é ENUM de lista fechada com CHECK (`no_asistio`, `horario_distinto`,
-- `horas_mal_cargadas`, `otro` — lista inicial, ajustável); a nota em texto livre é OPCIONAL,
-- CIFRADA com KMS (`note_encrypted`, nunca texto claro — regra dura CLAUDE.md: texto clínico nunca
-- em log/prompt/GBrain).
--
-- `country TEXT NOT NULL DEFAULT 'AR'` nas duas tabelas (convenção do repo). RLS por país e a
-- classificação de universo Enlite por agência (spec §Universo de pacientes / §isolamento por
-- país) ficam para quando os dados REAIS entrarem (fase 2/4, sob PARE do lex) — D345 moveu os 16
-- cenários de "Condições do parecer do lex" (inclusive RLS) para backlog; não são critério de
-- pronto da fase 1. Nenhum dado real é gravado nesta fase (só sintético).
--
-- Rollback (par desta migration, convenção do repo):
--   DROP TRIGGER IF EXISTS trg_shift_hours_validation_immutable ON shift_hours_validation;
--   DROP FUNCTION IF EXISTS anacare_shift_hours_validation_immutable();
--   DROP TABLE IF EXISTS shift_hours_validation;
--   DROP TABLE IF EXISTS anacare_shift;

BEGIN;

CREATE TABLE IF NOT EXISTS anacare_shift (
  id                 BIGSERIAL    PRIMARY KEY,
  source             TEXT         NOT NULL DEFAULT 'anacare',
  source_shift_id    TEXT         NOT NULL,
  ana_care_patient_id TEXT        NOT NULL,
  ana_care_nurse_id   TEXT        NOT NULL,
  patient_id         UUID         NULL REFERENCES patients(id),
  worker_id          UUID         NULL REFERENCES workers(id),
  period_month       DATE         NOT NULL,
  planned_start      TIMESTAMPTZ  NULL,
  planned_end        TIMESTAMPTZ  NULL,
  checkin_at         TIMESTAMPTZ  NULL,
  checkout_at        TIMESTAMPTZ  NULL,
  checkin_source     TEXT         NULL,
  checkout_source    TEXT         NULL,
  checkin_delay      NUMERIC      NULL,
  duration_hours     NUMERIC      NULL,
  country            TEXT         NOT NULL DEFAULT 'AR',
  fetched_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_anacare_shift_source_id UNIQUE (source, source_shift_id),
  CONSTRAINT chk_anacare_shift_source CHECK (source ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT chk_anacare_shift_checkin_source CHECK (checkin_source IS NULL OR checkin_source IN ('app', 'web_admin')),
  CONSTRAINT chk_anacare_shift_checkout_source CHECK (checkout_source IS NULL OR checkout_source IN ('app', 'web_admin')),
  CONSTRAINT chk_anacare_shift_period_month CHECK (period_month = date_trunc('month', period_month)::date)
);

CREATE INDEX IF NOT EXISTS idx_anacare_shift_period_patient ON anacare_shift (period_month, patient_id);
CREATE INDEX IF NOT EXISTS idx_anacare_shift_period_worker ON anacare_shift (period_month, worker_id);

COMMENT ON TABLE anacare_shift IS
  'Retrato operacional do turno do Ana Care (fase 1: nasce vazia — o job real de upsert noturno é '
  'fase 2/4, sob PARE do lex/D344). Reescrito toda noite; NUNCA guarda o OK da operadora (ver '
  'shift_hours_validation). Sem cache de nome (decisão do Gabriel 15/09).';

CREATE TABLE IF NOT EXISTS shift_hours_validation (
  id                      BIGSERIAL    PRIMARY KEY,
  source                  TEXT         NOT NULL DEFAULT 'anacare',
  source_shift_id         TEXT         NOT NULL,
  ana_care_patient_id     TEXT         NOT NULL,
  ana_care_nurse_id       TEXT         NOT NULL,
  period_month            DATE         NOT NULL,
  status                  TEXT         NOT NULL DEFAULT 'pendente',
  approved_hours          NUMERIC      NULL,
  approved_checkin_at     TIMESTAMPTZ  NULL,
  approved_checkout_at    TIMESTAMPTZ  NULL,
  approved_checkin_source TEXT         NULL,
  validated_by            VARCHAR(128) NULL REFERENCES users(firebase_uid),
  validated_at            TIMESTAMPTZ  NULL,
  reason                  TEXT         NULL,
  note_encrypted          TEXT         NULL,
  country                 TEXT         NOT NULL DEFAULT 'AR',
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_shift_hours_validation_source_id UNIQUE (source, source_shift_id),
  CONSTRAINT chk_shift_hours_validation_source CHECK (source ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT chk_shift_hours_validation_status CHECK (status IN ('pendente', 'validado', 'contestado')),
  CONSTRAINT chk_shift_hours_validation_reason CHECK (
    reason IS NULL OR reason IN ('no_asistio', 'horario_distinto', 'horas_mal_cargadas', 'otro')
  ),
  CONSTRAINT chk_shift_hours_validation_approved_checkin_source CHECK (
    approved_checkin_source IS NULL OR approved_checkin_source IN ('app', 'web_admin')
  ),
  CONSTRAINT chk_shift_hours_validation_period_month CHECK (period_month = date_trunc('month', period_month)::date),
  -- `validado` congela hours+validador; `contestado` exige motivo de lista fechada (nota é
  -- opcional, D344); `pendente` não tem nada congelado ainda.
  CONSTRAINT chk_shift_hours_validation_status_coerente CHECK (
    (status = 'pendente' AND approved_hours IS NULL AND validated_by IS NULL AND validated_at IS NULL AND reason IS NULL)
    OR (status = 'validado' AND approved_hours IS NOT NULL AND validated_by IS NOT NULL AND validated_at IS NOT NULL)
    OR (status = 'contestado' AND reason IS NOT NULL AND approved_hours IS NULL AND validated_by IS NULL AND validated_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_shift_hours_validation_period ON shift_hours_validation (period_month);
CREATE INDEX IF NOT EXISTS idx_shift_hours_validation_status ON shift_hours_validation (status);

COMMENT ON TABLE shift_hours_validation IS
  'O OK da operadora sobre um turno do Ana Care (workflow nosso, durável, NUNCA apagado pelo job '
  'noturno). Religa ao turno por (source, source_shift_id) — nunca por FK ao id do retrato. '
  '`note_encrypted` é a nota de contestação cifrada com KMS (D344) — nunca texto claro; o motivo '
  '(`reason`) é lista fechada, visível a quem tem leitura da tela.';
COMMENT ON COLUMN shift_hours_validation.note_encrypted IS
  'Ciphertext KMS (base64) da nota opcional de contestação. NUNCA decifrar em log/erro (D344; '
  'regra dura CLAUDE.md: texto clínico nunca sai do perímetro).';

-- Imutabilidade do congelado (CHECK não alcança "o valor anterior" — precisa de TRIGGER).
-- `validado` não permite alterar `status` nem nenhum `approved_*`; libera só `note_encrypted`
-- (e `updated_at`). Transições aceitas: pendente→validado, pendente→contestado,
-- contestado→validado — nunca reabre um validado, nunca volta a pendente.
CREATE OR REPLACE FUNCTION anacare_shift_hours_validation_immutable() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'validado' THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.approved_hours IS DISTINCT FROM OLD.approved_hours
       OR NEW.approved_checkin_at IS DISTINCT FROM OLD.approved_checkin_at
       OR NEW.approved_checkout_at IS DISTINCT FROM OLD.approved_checkout_at
       OR NEW.approved_checkin_source IS DISTINCT FROM OLD.approved_checkin_source
       OR NEW.validated_by IS DISTINCT FROM OLD.validated_by
       OR NEW.validated_at IS DISTINCT FROM OLD.validated_at
    THEN
      RAISE EXCEPTION 'shift_hours_validation: turno validado é imutável (só note_encrypted pode mudar)'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF OLD.status = 'contestado' AND NEW.status = 'pendente' THEN
    RAISE EXCEPTION 'shift_hours_validation: contestado não pode voltar a pendente' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_shift_hours_validation_immutable ON shift_hours_validation;
CREATE TRIGGER trg_shift_hours_validation_immutable
  BEFORE UPDATE ON shift_hours_validation
  FOR EACH ROW
  EXECUTE FUNCTION anacare_shift_hours_validation_immutable();

-- GRANT explícito por tabela (convenção do repo — sem ALTER DEFAULT PRIVILEGES, molde 430/436).
GRANT SELECT, INSERT, UPDATE ON anacare_shift TO app_runtime, app_system;
GRANT SELECT, INSERT, UPDATE ON shift_hours_validation TO app_runtime, app_system;
GRANT USAGE, SELECT ON SEQUENCE anacare_shift_id_seq TO app_runtime, app_system;
GRANT USAGE, SELECT ON SEQUENCE shift_hours_validation_id_seq TO app_runtime, app_system;

COMMIT;
