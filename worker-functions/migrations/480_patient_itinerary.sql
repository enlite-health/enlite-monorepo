-- 480 — itinerário do paciente: `patient_itinerary_slot` + `patient_itinerary_assignment`
-- (cadeia-paciente-vacante-itinerario, Fase 7; DX-7.1; D433 invariantes 4/5, D434 invariante 8,
-- `2026-09-23a#REGRA-24`).
--
-- ── O que é (a recorrência é SEMANAL) ────────────────────────────────────────
-- `patient_itinerary_slot` é a faixa semanal recorrente do serviço contratado: `(weekday,
-- start_time, end_time)`, derivada do `schedule` JSONB de `patient_contracted_services` (a
-- derivação mora em CASE/infrastructure/PatientItinerarySlotSync.ts, Fase 7, P5). Subconjunto
-- DELIBERADAMENTE menor que a `RRULE` do RFC 5545. NÃO expressa: quinzenal/mensal, feriado,
-- exceção pontual (a substituição datada é a Fase 13, tabela própria ao lado), faixa que cruza a
-- meia-noite (o editor do serviço já recusa isso hoje — `contractedServiceSchemas.ts:19-26` —
-- turno noturno vira duas faixas), fuso (a hora é a local do endereço do serviço).
-- `patient_itinerary_assignment` é o prestador alocado num slot, com vigência (`valid_from`,
-- `valid_to` inclusivo). NÃO é registro de jornada/check-in (o realizado é do Ana Care,
-- `2026-09-23a#FATO-07`, fora daqui) — nenhuma coluna de texto clínico, nenhuma de check-in/check-out.
-- Sem backfill: os slots nascem só da criação/edição do serviço (DX-5) — serviço cujo horário não
-- foi salvo DEPOIS desta migration fica sem slot até alguém editar.
--
-- ── Por que RLS aqui, se `contracted_service_providers` (319) — a tabela que este itinerário
-- substitui — não tem ────────────────────────────────────────────────────────
-- `contracted_service_providers` ficou sem RLS por ser neta e anterior à 411 (RLS de `patients`).
-- Esta nasce depois, com o molde já vivo (429 é neta e tem RLS) — e guarda quem cuida de quem.
-- A leitura de produção (`inPatientTransaction`) já filtra pela junção com `patients`, mas
-- qualquer leitura futura sem essa junção vazaria sem a policy. A régua é o P3 desta fase.
--
-- ── Candidatura daquela vaga, no banco (invariante 5) ────────────────────────
-- Sem o trigger de candidatura abaixo, a FK aceitaria a alocação de QUALQUER worker e QUALQUER
-- application_id — "candidato daquela vaga" seria instrução no caso de uso da Fase 11, não
-- controle. Trava no banco: `worker_job_applications.worker_id` tem de ser o mesmo do
-- `NEW.worker_id`, e o `job_postings.contracted_service_id` da vaga da candidatura tem de ser o
-- mesmo serviço do slot.
--
-- ── Sem DELETE para o app (mesma régua de 319:165-168) ───────────────────────
-- O default privilege do schema (`269_app_runtime_roles.sql:66-69`) dá `arwd` a
-- `app_runtime`/`app_system` em toda tabela nova — por isso o REVOKE explícito abaixo. Slot sai
-- por `active=false` (nunca DELETE — a alocação aponta para a linha); alocação por
-- `valid_to`/`status`. Trilha, não lixo. A cascata da purga do paciente (D248) roda pelas ações
-- referenciais (dono da tabela), não pelo DELETE do app.
--
-- `enlite_mcp_ro` não recebe nada: o default privilege da 269 não a cita, e a tabela não entra
-- em `scripts/create-mcp-ro-role.sql`.
--
-- Idempotente (2×): `IF NOT EXISTS` / `DROP … IF EXISTS` antes de cada `ADD CONSTRAINT` /
-- `CREATE POLICY` / `CREATE TRIGGER`. Sem `BEGIN/COMMIT` próprio (molde 476).
--
-- Rollback: `migrations/pending/ROLLBACK_480_patient_itinerary.sql` (trava de dado: recusa se
-- houver alocação).

-- ── patient_itinerary_slot ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS patient_itinerary_slot (
  id                     UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  contracted_service_id  UUID         NOT NULL REFERENCES patient_contracted_services(id) ON DELETE CASCADE,
  weekday                SMALLINT     NOT NULL,
  start_time             TIME         NOT NULL,
  end_time               TIME         NOT NULL,
  active                 BOOLEAN      NOT NULL DEFAULT true,
  country                TEXT         NULL,  -- etapa 1: trigger abaixo preenche; etapa 2: NOT NULL; etapa 3: CHECK
  created_by             VARCHAR(128) NOT NULL,
  updated_by             VARCHAR(128) NOT NULL,
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT pis_weekday_range CHECK (weekday BETWEEN 0 AND 6),
  CONSTRAINT pis_time_order CHECK (end_time > start_time)
);

-- Chave natural da derivação (DX-7.5): a reativação reusa a MESMA linha (a alocação aponta para
-- ela) — cheia, não parcial.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pis_service_slot_uq'
  ) THEN
    ALTER TABLE patient_itinerary_slot
      ADD CONSTRAINT pis_service_slot_uq UNIQUE (contracted_service_id, weekday, start_time, end_time);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_pis_service ON patient_itinerary_slot (contracted_service_id);

-- ── patient_itinerary_assignment ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS patient_itinerary_assignment (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id        UUID         NOT NULL REFERENCES patient_itinerary_slot(id) ON DELETE CASCADE,
  worker_id      UUID         NOT NULL REFERENCES workers(id),
  application_id UUID         NOT NULL REFERENCES worker_job_applications(id),
  valid_from     DATE         NOT NULL,
  valid_to       DATE         NULL,  -- NULL = vigente sem fim; inclusivo (o último dia trabalhado)
  status         TEXT         NOT NULL DEFAULT 'ACTIVE',
  country        TEXT         NULL,  -- etapa 1: trigger abaixo preenche; etapa 2: NOT NULL; etapa 3: CHECK
  created_by     VARCHAR(128) NOT NULL,
  updated_by     VARCHAR(128) NOT NULL,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),

  -- Conjunto fechado, sem texto livre: ACTIVE = alocação em vigor no intervalo; ENDED = encerrada
  -- (exige valid_to); CANCELLED = registrada por engano, nunca conta.
  CONSTRAINT pia_status_check CHECK (status IN ('ACTIVE', 'ENDED', 'CANCELLED')),
  CONSTRAINT pia_valid_range CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT pia_ended_has_end CHECK (status <> 'ENDED' OR valid_to IS NOT NULL)
);

-- O mesmo prestador não fica aberto duas vezes no mesmo slot; OUTRO prestador no mesmo slot pode
-- (P2 — Diego, não trava; molde uq_contracted_service_providers_active_pair, 319:200-201).
CREATE UNIQUE INDEX IF NOT EXISTS uq_pia_open_pair
  ON patient_itinerary_assignment (slot_id, worker_id) WHERE status = 'ACTIVE' AND valid_to IS NULL;

CREATE INDEX IF NOT EXISTS idx_pia_slot ON patient_itinerary_assignment (slot_id);
CREATE INDEX IF NOT EXISTS idx_pia_worker ON patient_itinerary_assignment (worker_id);
CREATE INDEX IF NOT EXISTS idx_pia_application ON patient_itinerary_assignment (application_id);

-- ── country: 3 etapas (molde 429:100-122) ────────────────────────────────────
-- Etapa 1: trigger BEFORE INSERT copia o país do pai (só quando NEW.country IS NULL).
CREATE OR REPLACE FUNCTION fn_patient_itinerary_slot_country_from_service()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.country IS NULL THEN
    SELECT pcs.country INTO NEW.country FROM patient_contracted_services pcs WHERE pcs.id = NEW.contracted_service_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_patient_itinerary_slot_country ON patient_itinerary_slot;
CREATE TRIGGER trg_patient_itinerary_slot_country
  BEFORE INSERT ON patient_itinerary_slot
  FOR EACH ROW EXECUTE FUNCTION fn_patient_itinerary_slot_country_from_service();

CREATE OR REPLACE FUNCTION fn_patient_itinerary_assignment_country_from_slot()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.country IS NULL THEN
    SELECT s.country INTO NEW.country FROM patient_itinerary_slot s WHERE s.id = NEW.slot_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_patient_itinerary_assignment_country ON patient_itinerary_assignment;
CREATE TRIGGER trg_patient_itinerary_assignment_country
  BEFORE INSERT ON patient_itinerary_assignment
  FOR EACH ROW EXECUTE FUNCTION fn_patient_itinerary_assignment_country_from_slot();

-- Etapa 2: NOT NULL só depois do trigger existir (as tabelas nascem vazias nesta árvore).
ALTER TABLE patient_itinerary_slot ALTER COLUMN country SET NOT NULL;
ALTER TABLE patient_itinerary_assignment ALTER COLUMN country SET NOT NULL;

-- Etapa 3: CHECK do país.
ALTER TABLE patient_itinerary_slot DROP CONSTRAINT IF EXISTS pis_country_check;
ALTER TABLE patient_itinerary_slot
  ADD CONSTRAINT pis_country_check CHECK (country IN ('AR', 'BR'));

ALTER TABLE patient_itinerary_assignment DROP CONSTRAINT IF EXISTS pia_country_check;
ALTER TABLE patient_itinerary_assignment
  ADD CONSTRAINT pia_country_check CHECK (country IN ('AR', 'BR'));

-- ── Candidatura daquela vaga, no banco (invariante 5) ────────────────────────
-- ⚑ Implementada (padrão do plano, DX-7.1; o Gabriel não respondeu). Sem isso, a FK aceitaria a
-- candidatura de QUALQUER vaga e QUALQUER prestador.
CREATE OR REPLACE FUNCTION fn_patient_itinerary_assignment_candidacy()
RETURNS TRIGGER AS $$
DECLARE
  v_wja_worker_id UUID;
  v_jp_contracted_service_id UUID;
  v_slot_contracted_service_id UUID;
BEGIN
  SELECT wja.worker_id, jp.contracted_service_id
    INTO v_wja_worker_id, v_jp_contracted_service_id
    FROM worker_job_applications wja
    JOIN job_postings jp ON jp.id = wja.job_posting_id
    WHERE wja.id = NEW.application_id;

  SELECT s.contracted_service_id INTO v_slot_contracted_service_id
    FROM patient_itinerary_slot s WHERE s.id = NEW.slot_id;

  IF v_wja_worker_id IS DISTINCT FROM NEW.worker_id THEN
    RAISE EXCEPTION 'pia_candidatura_de_outro_prestador' USING ERRCODE = '23514';
  END IF;

  IF v_jp_contracted_service_id IS DISTINCT FROM v_slot_contracted_service_id THEN
    RAISE EXCEPTION 'pia_candidatura_de_outra_vaga' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_patient_itinerary_assignment_candidacy ON patient_itinerary_assignment;
CREATE TRIGGER trg_patient_itinerary_assignment_candidacy
  BEFORE INSERT OR UPDATE OF slot_id, worker_id, application_id ON patient_itinerary_assignment
  FOR EACH ROW EXECUTE FUNCTION fn_patient_itinerary_assignment_candidacy();

-- ── RLS: segue o pai (molde 429, bloco final, e 413:26-39) ───────────────────
ALTER TABLE patient_itinerary_slot ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS patient_itinerary_slot_follow_service ON patient_itinerary_slot;
CREATE POLICY patient_itinerary_slot_follow_service ON patient_itinerary_slot FOR ALL USING (
  (
    NULLIF(current_setting('app.system_context', true), '') IS NOT NULL
    AND pg_has_role(current_user, 'app_system', 'MEMBER')
  )
  OR EXISTS (SELECT 1 FROM patient_contracted_services pcs WHERE pcs.id = patient_itinerary_slot.contracted_service_id)
);

ALTER TABLE patient_itinerary_assignment ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS patient_itinerary_assignment_follow_slot ON patient_itinerary_assignment;
CREATE POLICY patient_itinerary_assignment_follow_slot ON patient_itinerary_assignment FOR ALL USING (
  (
    NULLIF(current_setting('app.system_context', true), '') IS NOT NULL
    AND pg_has_role(current_user, 'app_system', 'MEMBER')
  )
  OR EXISTS (SELECT 1 FROM patient_itinerary_slot s WHERE s.id = patient_itinerary_assignment.slot_id)
);

-- ── GRANT/REVOKE (molde 476:482-483) — sem DELETE para o app ─────────────────
GRANT SELECT, INSERT, UPDATE ON patient_itinerary_slot, patient_itinerary_assignment TO app_runtime, app_system;
REVOKE DELETE ON patient_itinerary_slot, patient_itinerary_assignment FROM app_runtime, app_system;

COMMENT ON TABLE patient_itinerary_slot IS
  'Faixa semanal recorrente do serviço contratado, derivada do schedule JSONB (Fase 7, DX-7.5). '
  'A recorrência é SEMANAL: (weekday, start_time, end_time) — subconjunto deliberadamente menor '
  'que a RRULE do RFC 5545. NÃO expressa: quinzenal/mensal, feriado, exceção pontual (a '
  'substituição datada é a Fase 13, tabela própria ao lado), faixa que cruza a meia-noite (o '
  'editor do serviço já recusa, contractedServiceSchemas.ts:26; turno noturno = duas faixas), '
  'fuso (a hora é a local do endereço do serviço). Nenhuma coluna de texto clínico; nenhuma de '
  'check-in/check-out (o realizado é do Ana Care, 2026-09-23a#FATO-07, fora). Sem backfill: '
  'slots nascem da criação/edição do serviço (DX-5). Sem address_id (invariante 8; o endereço é '
  'o do serviço, por junção). Rollback: migrations/pending/ROLLBACK_480_patient_itinerary.sql.';
COMMENT ON TABLE patient_itinerary_assignment IS
  'Prestador alocado num slot do itinerário, com vigência (valid_from/valid_to inclusivo). NÃO é '
  'registro de jornada/check-in (Ana Care, fora daqui). candidacy trigger garante que '
  'application_id é candidatura DAQUELA vaga e DAQUELE prestador (invariante 5). Rollback: '
  'migrations/pending/ROLLBACK_480_patient_itinerary.sql.';
COMMENT ON COLUMN patient_itinerary_slot.country IS
  'Herdado de patient_contracted_services.country por trigger (etapa 1/3). NOT NULL (etapa 2/3) + CHECK AR/BR (etapa 3/3).';
COMMENT ON COLUMN patient_itinerary_assignment.country IS
  'Herdado de patient_itinerary_slot.country por trigger (etapa 1/3). NOT NULL (etapa 2/3) + CHECK AR/BR (etapa 3/3).';
