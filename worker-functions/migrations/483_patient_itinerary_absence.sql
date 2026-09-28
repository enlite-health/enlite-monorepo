-- 483 — a ausência pontual do titular: a tabela, a validação e a trava por data na MESMA
-- função da trava semanal (cadeia-paciente-vacante-itinerario, Fase 13; DX-13.1, DX-13.2;
-- D434 invariantes 4/5/9/10).
--
-- ── Sem motivo gravado: pode ser clínico ──────────────────────────────────────
-- Esta tabela não guarda POR QUE o titular faltou — só QUEM, QUANDO e QUEM SUBSTITUI (se
-- houver). Nenhuma coluna de texto livre (motivo, observação); as únicas colunas de texto
-- são country, created_by, updated_by, cancelled_by.
--
-- ── A ausência não move nada fora dela mesma ──────────────────────────────────
-- Não entra na conta de horas (Fase 7 — ServiceCoverageCalculator/itineraryCoverage
-- continuam lendo só slot + alocação) nem move o status do paciente (Fase 15). O efeito dela
-- é só o alerta (leitura) e a trava de sobreposição abaixo.
--
-- ── Q-S1 (padrão): ausência sem substituto existe ─────────────────────────────
-- É o alerta — o titular falta e ninguém cobre aquele dia; a tabela aceita
-- substitute_worker_id/substitute_application_id NULOS.
--
-- ── Q-S2 (padrão): o titular ausente continua bloqueando o horário dele ───────
-- A trava (ramo semanal) NÃO desconta a ausência do próprio titular — a alocação semanal dele
-- segue reservando o horário mesmo no dia em que faltou (nunca aceita o que o invariante 4
-- recusaria fora desse dia).
--
-- ── Um gatilho só, a MESMA trava (DX-13.2) ────────────────────────────────────
-- O conflito de horário do prestador é UMA regra: itinerary_worker_conflict(…) abaixo. Os
-- dois gatilhos finos (o da alocação semanal — CREATE OR REPLACE da função da 482, MESMO
-- nome, MESMO gatilho, não recriado — e o novo desta tabela) só leem o slot, tomam o MESMO
-- lock por prestador e chamam essa função só. A folga entre endereços diferentes continua
-- sendo SÓ itinerary_min_gap_minutes() (482, intocada).
--
-- Idempotente (2×): `IF NOT EXISTS` / `DROP … IF EXISTS` / `CREATE OR REPLACE` antes de cada
-- objeto. Sem `BEGIN/COMMIT` próprio (molde 482/481/480).
--
-- Rollback: `migrations/pending/ROLLBACK_483_patient_itinerary_absence.sql` (trava de dado:
-- recusa se houver ausência registrada; restaura fn_patient_itinerary_assignment_no_overlap()
-- ao corpo literal da 482; rodar ANTES do
-- `ROLLBACK_482_patient_itinerary_assembly_and_overlap.sql`).

-- ── patient_itinerary_absence ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS patient_itinerary_absence (
  id                         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id              UUID         NOT NULL REFERENCES patient_itinerary_assignment(id) ON DELETE CASCADE,
  on_date                    DATE         NOT NULL,
  substitute_worker_id       UUID         NULL REFERENCES workers(id),
  substitute_application_id  UUID         NULL REFERENCES worker_job_applications(id),
  cancelled_at               TIMESTAMPTZ  NULL,
  cancelled_by               VARCHAR(128) NULL,
  country                    TEXT         NULL,  -- etapa 1: trigger abaixo preenche; etapa 2: NOT NULL; etapa 3: CHECK
  created_by                 VARCHAR(128) NOT NULL,
  updated_by                 VARCHAR(128) NOT NULL,
  created_at                 TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ  NOT NULL DEFAULT now(),

  -- invariante 5 no banco: os dois campos do substituto nascem/morrem juntos.
  CONSTRAINT piab_substitute_pair CHECK ((substitute_worker_id IS NULL) = (substitute_application_id IS NULL)),
  -- cancelar é rastreável: os dois campos do cancelamento nascem/morrem juntos.
  CONSTRAINT piab_cancel_pair CHECK ((cancelled_at IS NULL) = (cancelled_by IS NULL))
);

-- Não pode haver duas ausências abertas na MESMA alocação e MESMA data.
CREATE UNIQUE INDEX IF NOT EXISTS uq_piab_open
  ON patient_itinerary_absence (assignment_id, on_date) WHERE cancelled_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_piab_assignment ON patient_itinerary_absence (assignment_id);
CREATE INDEX IF NOT EXISTS idx_piab_substitute_date
  ON patient_itinerary_absence (substitute_worker_id, on_date) WHERE cancelled_at IS NULL;

-- ── fn_patient_itinerary_absence_validate(): a validação — INVOKER, lê só a cadeia do
-- próprio paciente ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_patient_itinerary_absence_validate()
RETURNS TRIGGER AS $$
DECLARE
  v_worker_id     UUID;
  v_status        TEXT;
  v_valid_from    DATE;
  v_valid_to      DATE;
  v_weekday       SMALLINT;
  v_service_id    UUID;
  v_wja_worker_id UUID;
  v_jp_service_id UUID;
BEGIN
  -- imutabilidade e "cancelada não volta" só fazem sentido com OLD (UPDATE).
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.assignment_id, NEW.on_date) IS DISTINCT FROM (OLD.assignment_id, OLD.on_date) THEN
      RAISE EXCEPTION 'piab_chave_imutavel' USING ERRCODE = '23514';
    END IF;

    IF OLD.cancelled_at IS NOT NULL THEN
      RAISE EXCEPTION 'piab_cancelada' USING ERRCODE = '23514';
    END IF;

    -- Gate parcial #1: cancelar é SEMPRE permitido — mesmo quando a alocação do titular já foi
    -- encerrada/cancelada ou a data saiu da vigência. Vale só para o UPDATE que muda
    -- exclusivamente cancelled_at/cancelled_by/updated_by/updated_at (e de fato cancela);
    -- qualquer outra mudança segue para a validação completa abaixo.
    IF NEW.cancelled_at IS NOT NULL
       AND (to_jsonb(NEW) - ARRAY['cancelled_at', 'cancelled_by', 'updated_by', 'updated_at'])
         = (to_jsonb(OLD) - ARRAY['cancelled_at', 'cancelled_by', 'updated_by', 'updated_at']) THEN
      RETURN NEW;
    END IF;
  END IF;

  -- deferências às constraints nativas (molde 480:167-182): esta trigger roda BEFORE ROW,
  -- antes do NOT NULL/FK da própria linha — se lançar exceção aqui sem checar isso, o
  -- Postgres nunca chega a avaliar 23502/23503.
  IF NEW.assignment_id IS NULL OR NEW.on_date IS NULL THEN
    RETURN NEW; -- deixa o NOT NULL decidir
  END IF;

  SELECT a.worker_id, a.status, a.valid_from, a.valid_to, s.weekday, s.contracted_service_id
    INTO v_worker_id, v_status, v_valid_from, v_valid_to, v_weekday, v_service_id
    FROM patient_itinerary_assignment a
    JOIN patient_itinerary_slot s ON s.id = a.slot_id
    WHERE a.id = NEW.assignment_id;

  IF NOT FOUND THEN
    RETURN NEW; -- deixa a FK de assignment_id decidir
  END IF;

  IF v_status <> 'ACTIVE' OR NEW.on_date < v_valid_from OR NEW.on_date > COALESCE(v_valid_to, 'infinity'::date) THEN
    RAISE EXCEPTION 'piab_fora_da_vigencia' USING ERRCODE = '23514';
  END IF;

  IF extract(dow FROM NEW.on_date) <> v_weekday THEN
    RAISE EXCEPTION 'piab_dia_da_semana' USING ERRCODE = '23514';
  END IF;

  IF NEW.substitute_worker_id IS NOT NULL AND NEW.substitute_application_id IS NOT NULL THEN
    SELECT wja.worker_id, jp.contracted_service_id
      INTO v_wja_worker_id, v_jp_service_id
      FROM worker_job_applications wja
      JOIN job_postings jp ON jp.id = wja.job_posting_id
      WHERE wja.id = NEW.substitute_application_id;

    IF FOUND THEN
      -- a candidatura tem de ser do MESMO worker e da vaga do MESMO serviço do slot (molde
      -- 480:174-193).
      IF v_wja_worker_id IS DISTINCT FROM NEW.substitute_worker_id THEN
        RAISE EXCEPTION 'piab_candidatura_de_outro_prestador' USING ERRCODE = '23514';
      END IF;

      IF v_jp_service_id IS DISTINCT FROM v_service_id THEN
        RAISE EXCEPTION 'piab_candidatura_de_outra_vaga' USING ERRCODE = '23514';
      END IF;

      IF NEW.substitute_worker_id = v_worker_id THEN
        RAISE EXCEPTION 'piab_substituto_e_o_titular' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_patient_itinerary_absence_1_validate ON patient_itinerary_absence;
CREATE TRIGGER trg_patient_itinerary_absence_1_validate
  BEFORE INSERT OR UPDATE ON patient_itinerary_absence
  FOR EACH ROW EXECUTE FUNCTION fn_patient_itinerary_absence_validate();

-- ── country: 3 etapas (molde 482:54-82) ────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_patient_itinerary_absence_country_from_assignment()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.country IS NULL THEN
    SELECT a.country INTO NEW.country FROM patient_itinerary_assignment a WHERE a.id = NEW.assignment_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_patient_itinerary_absence_2_country ON patient_itinerary_absence;
CREATE TRIGGER trg_patient_itinerary_absence_2_country
  BEFORE INSERT ON patient_itinerary_absence
  FOR EACH ROW EXECUTE FUNCTION fn_patient_itinerary_absence_country_from_assignment();

-- Etapa 2: NOT NULL só depois do trigger existir (a tabela nasce vazia nesta árvore).
ALTER TABLE patient_itinerary_absence ALTER COLUMN country SET NOT NULL;

-- Etapa 3: CHECK do país.
ALTER TABLE patient_itinerary_absence DROP CONSTRAINT IF EXISTS piab_country_check;
ALTER TABLE patient_itinerary_absence
  ADD CONSTRAINT piab_country_check CHECK (country IN ('AR', 'BR'));

-- ── RLS: segue a alocação (molde 480:215-223) ─────────────────────────────────
ALTER TABLE patient_itinerary_absence ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS patient_itinerary_absence_follow_assignment ON patient_itinerary_absence;
CREATE POLICY patient_itinerary_absence_follow_assignment ON patient_itinerary_absence FOR ALL USING (
  (
    NULLIF(current_setting('app.system_context', true), '') IS NOT NULL
    AND pg_has_role(current_user, 'app_system', 'MEMBER')
  )
  OR EXISTS (SELECT 1 FROM patient_itinerary_assignment a WHERE a.id = patient_itinerary_absence.assignment_id)
);

-- ── GRANT/REVOKE — cancelar é UPDATE, nunca DELETE ───────────────────────────
GRANT SELECT, INSERT, UPDATE ON patient_itinerary_absence TO app_runtime, app_system;
REVOKE DELETE ON patient_itinerary_absence FROM app_runtime, app_system;

COMMENT ON TABLE patient_itinerary_absence IS
  'Ausência pontual do titular numa data, com substituto opcional (Fase 13, DX-13.1; D434 '
  'invariantes 4/5/9/10). Sem motivo gravado: pode ser clínico. NÃO entra na conta de horas '
  '(Fase 7) nem move o paciente (Fase 15) — é só o alerta e a trava de sobreposição do '
  'substituto. Q-S1 (padrão): ausência sem substituto existe — é o alerta. Q-S2 (padrão): o '
  'titular ausente continua bloqueando o horário dele. Sem DELETE (cancelar é UPDATE '
  'cancelled_at). Rollback: migrations/pending/ROLLBACK_483_patient_itinerary_absence.sql.';
COMMENT ON COLUMN patient_itinerary_absence.country IS
  'Herdado de patient_itinerary_assignment.country por trigger (etapa 1/3). NOT NULL (etapa '
  '2/3) + CHECK AR/BR (etapa 3/3).';

-- ── itinerary_worker_conflict(): UMA função, chamada pelos dois gatilhos finos (DX-13.2) ──
-- INVOKER sem EXECUTE para o app (REVOKE abaixo, sem GRANT): só é chamável de dentro das
-- SECURITY DEFINER que a chamam (fn_patient_itinerary_assignment_no_overlap e
-- fn_patient_itinerary_absence_no_overlap, ambas abaixo) — nelas o "invoker" é o dono da
-- tabela, então ela vê qualquer serviço de qualquer paciente, como a 482 já fazia.
CREATE OR REPLACE FUNCTION itinerary_worker_conflict(
  p_worker             UUID,
  p_weekday            SMALLINT,
  p_start_min          INT,
  p_end_min            INT,
  p_address            UUID,
  p_from               DATE,
  p_to                 DATE,
  p_ignore_assignment  UUID,
  p_ignore_absence     UUID,
  p_open_pair_slot     UUID
)
RETURNS TABLE (
  service_id  UUID,
  weekday     SMALLINT,
  start_time  TIME,
  end_time    TIME,
  address_id  UUID
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  SELECT c.service_id, c.weekday, c.start_time, c.end_time, c.address_id
    FROM (
      -- ramo semanal: outras alocações ACTIVE do mesmo prestador (o SELECT de 482:188-205,
      -- movido, idêntico).
      SELECT s2.contracted_service_id AS service_id, s2.weekday, s2.start_time, s2.end_time,
             pcs2.address_id AS address_id
        FROM patient_itinerary_assignment a
        JOIN patient_itinerary_slot s2 ON s2.id = a.slot_id
        JOIN patient_contracted_services pcs2 ON pcs2.id = s2.contracted_service_id
        WHERE a.worker_id = p_worker
          AND a.status = 'ACTIVE'
          AND a.id IS DISTINCT FROM p_ignore_assignment
          -- deferência ao uq_pia_open_pair (ressalva c', mesmo par nunca colide consigo mesmo)
          AND NOT (p_open_pair_slot IS NOT NULL AND a.slot_id = p_open_pair_slot
                   AND a.valid_to IS NULL AND p_to IS NULL)
          AND s2.weekday = p_weekday
          AND a.valid_from <= COALESCE(p_to, 'infinity'::date)
          AND COALESCE(a.valid_to, 'infinity'::date) >= p_from

      UNION ALL

      -- ramo da substituição: ausências não canceladas em que o prestador é SUBSTITUTO, só
      -- sobre alocação do titular ACTIVE e vigente NA DATA da ausência (gate parcial #1 — a
      -- ausência sobre alocação encerrada não bloqueia mais ninguém).
      SELECT s3.contracted_service_id AS service_id, s3.weekday, s3.start_time, s3.end_time,
             pcs3.address_id AS address_id
        FROM patient_itinerary_absence ab
        JOIN patient_itinerary_assignment a3 ON a3.id = ab.assignment_id
        JOIN patient_itinerary_slot s3 ON s3.id = a3.slot_id
        JOIN patient_contracted_services pcs3 ON pcs3.id = s3.contracted_service_id
        WHERE ab.substitute_worker_id = p_worker
          AND ab.cancelled_at IS NULL
          AND a3.status = 'ACTIVE'
          AND a3.valid_from <= ab.on_date
          AND (a3.valid_to IS NULL OR a3.valid_to >= ab.on_date)
          AND ab.id IS DISTINCT FROM p_ignore_absence
          AND ab.on_date BETWEEN p_from AND COALESCE(p_to, 'infinity'::date)
          AND extract(dow FROM ab.on_date) = p_weekday
    ) c, (SELECT itinerary_min_gap_minutes() AS v_gap) g
    WHERE
      -- mesmo endereço: só não pode SOBREPOR (predicado de 482:206-216, movido, idêntico)
      (c.address_id IS NOT NULL AND c.address_id = p_address
        AND (extract(epoch FROM c.start_time) / 60)::int < p_end_min
        AND p_start_min < (extract(epoch FROM c.end_time) / 60)::int)
      OR
      -- endereços diferentes ou algum NULL (conservador: exige a folga)
      (NOT (c.address_id IS NOT NULL AND c.address_id = p_address)
        AND (extract(epoch FROM c.start_time) / 60)::int < p_end_min + g.v_gap
        AND p_start_min < (extract(epoch FROM c.end_time) / 60)::int + g.v_gap)
    ORDER BY c.start_time
    LIMIT 1
$$;

REVOKE ALL ON FUNCTION itinerary_worker_conflict(
  UUID, SMALLINT, INT, INT, UUID, DATE, DATE, UUID, UUID, UUID
) FROM PUBLIC;

-- ── (i) fn_patient_itinerary_assignment_no_overlap(): CREATE OR REPLACE — MESMO nome, MESMO
-- gatilho (o trg_patient_itinerary_assignment_no_overlap da 482 NÃO é recriado aqui) ───────
CREATE OR REPLACE FUNCTION fn_patient_itinerary_assignment_no_overlap()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_gap               INT := itinerary_min_gap_minutes();
  v_weekday           SMALLINT;
  v_start_time        TIME;
  v_end_time          TIME;
  v_start_min         INT;
  v_end_min           INT;
  v_service_id        UUID;
  v_address_id        UUID;
  v_c_service_id       UUID;
  v_c_weekday          SMALLINT;
  v_c_start_time       TIME;
  v_c_end_time         TIME;
  v_c_address_id        UUID;
  v_same_address        BOOLEAN;
BEGIN
  -- (i) deferências às constraints nativas (ressalva c', DX-11.3) — idênticas à 482:153-167.
  IF NEW.status IS DISTINCT FROM 'ACTIVE' THEN
    RETURN NEW; -- encerrar/cancelar nunca é barrado pela trava
  END IF;

  IF NEW.slot_id IS NULL OR NEW.worker_id IS NULL OR NEW.valid_from IS NULL THEN
    RETURN NEW; -- deixa o NOT NULL da coluna decidir
  END IF;

  IF NEW.valid_to IS NOT NULL AND NEW.valid_to < NEW.valid_from THEN
    RETURN NEW; -- deixa pia_valid_range decidir
  END IF;

  -- (ii) serializa por prestador — idêntico à 482:171.
  PERFORM pg_advisory_xact_lock(hashtext('itinerary:worker:' || NEW.worker_id::text));

  -- (iii) o slot novo, com o endereço do SERVIÇO — idêntico à 482:174-185.
  SELECT s.weekday, s.start_time, s.end_time,
         (extract(epoch FROM s.start_time) / 60)::int,
         (extract(epoch FROM s.end_time) / 60)::int,
         s.contracted_service_id, pcs.address_id
    INTO v_weekday, v_start_time, v_end_time, v_start_min, v_end_min, v_service_id, v_address_id
    FROM patient_itinerary_slot s
    JOIN patient_contracted_services pcs ON pcs.id = s.contracted_service_id
    WHERE s.id = NEW.slot_id;

  IF NOT FOUND THEN
    RETURN NEW; -- deixa a FK de slot_id decidir
  END IF;

  -- (iv) procura UM conflito, pela função única (DX-13.2) — o efeito novo: a alocação
  -- semanal passa a recusar sobreposição com uma substituição datada do mesmo prestador.
  SELECT * INTO v_c_service_id, v_c_weekday, v_c_start_time, v_c_end_time, v_c_address_id
    FROM itinerary_worker_conflict(
      NEW.worker_id, v_weekday, v_start_min, v_end_min, v_address_id,
      NEW.valid_from, NEW.valid_to, NEW.id, NULL, NEW.slot_id
    );

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  v_same_address := (v_address_id IS NOT NULL AND v_c_address_id = v_address_id);

  -- (v) 23P01, DETAIL idêntico ao de 482:228-241 (as mesmas 10 chaves — fromPgError lê sem
  -- mudança).
  RAISE EXCEPTION 'itinerary_overlap' USING
    ERRCODE = '23P01',
    DETAIL = json_build_object(
      'existingServiceId', v_c_service_id,
      'existingWeekday', v_c_weekday,
      'existingStart', to_char(v_c_start_time, 'HH24:MI'),
      'existingEnd', to_char(v_c_end_time, 'HH24:MI'),
      'requestedServiceId', v_service_id,
      'requestedWeekday', v_weekday,
      'requestedStart', to_char(v_start_time, 'HH24:MI'),
      'requestedEnd', to_char(v_end_time, 'HH24:MI'),
      'sameAddress', v_same_address,
      'minGapMinutes', CASE WHEN v_same_address THEN NULL ELSE v_gap END
    )::text;
END;
$$;

REVOKE ALL ON FUNCTION fn_patient_itinerary_assignment_no_overlap() FROM PUBLIC;

-- ── (ii) fn_patient_itinerary_absence_no_overlap() + trg_…_3_no_overlap ──────────────────
CREATE OR REPLACE FUNCTION fn_patient_itinerary_absence_no_overlap()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_gap          INT := itinerary_min_gap_minutes();
  v_weekday      SMALLINT;
  v_start_time   TIME;
  v_end_time     TIME;
  v_start_min    INT;
  v_end_min      INT;
  v_service_id   UUID;
  v_address_id   UUID;
  v_c_service_id UUID;
  v_c_weekday    SMALLINT;
  v_c_start_time TIME;
  v_c_end_time   TIME;
  v_c_address_id UUID;
  v_same_address BOOLEAN;
BEGIN
  -- ausência sem substituto e cancelar nunca são barrados pela trava.
  IF NEW.substitute_worker_id IS NULL OR NEW.cancelled_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- a MESMA chave do 482:171 — uma alocação semanal e uma substituição do mesmo prestador se
  -- enfileiram entre si.
  PERFORM pg_advisory_xact_lock(hashtext('itinerary:worker:' || NEW.substitute_worker_id::text));

  -- o slot da alocação AUSENTE (o titular que falta), com o endereço do serviço.
  SELECT s.weekday, s.start_time, s.end_time,
         (extract(epoch FROM s.start_time) / 60)::int,
         (extract(epoch FROM s.end_time) / 60)::int,
         s.contracted_service_id, pcs.address_id
    INTO v_weekday, v_start_time, v_end_time, v_start_min, v_end_min, v_service_id, v_address_id
    FROM patient_itinerary_assignment a
    JOIN patient_itinerary_slot s ON s.id = a.slot_id
    JOIN patient_contracted_services pcs ON pcs.id = s.contracted_service_id
    WHERE a.id = NEW.assignment_id;

  IF NOT FOUND THEN
    RETURN NEW; -- deixa a FK de assignment_id decidir
  END IF;

  -- Q-S2 (padrão): o ramo semanal NÃO desconta a ausência do próprio substituto naquele dia —
  -- o titular ausente continua bloqueando o horário dele.
  SELECT * INTO v_c_service_id, v_c_weekday, v_c_start_time, v_c_end_time, v_c_address_id
    FROM itinerary_worker_conflict(
      NEW.substitute_worker_id, v_weekday, v_start_min, v_end_min, v_address_id,
      NEW.on_date, NEW.on_date, NULL, NEW.id, NULL
    );

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  v_same_address := (v_address_id IS NOT NULL AND v_c_address_id = v_address_id);

  RAISE EXCEPTION 'itinerary_overlap' USING
    ERRCODE = '23P01',
    DETAIL = json_build_object(
      'existingServiceId', v_c_service_id,
      'existingWeekday', v_c_weekday,
      'existingStart', to_char(v_c_start_time, 'HH24:MI'),
      'existingEnd', to_char(v_c_end_time, 'HH24:MI'),
      'requestedServiceId', v_service_id,
      'requestedWeekday', v_weekday,
      'requestedStart', to_char(v_start_time, 'HH24:MI'),
      'requestedEnd', to_char(v_end_time, 'HH24:MI'),
      'sameAddress', v_same_address,
      'minGapMinutes', CASE WHEN v_same_address THEN NULL ELSE v_gap END
    )::text;
END;
$$;

REVOKE ALL ON FUNCTION fn_patient_itinerary_absence_no_overlap() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_patient_itinerary_absence_3_no_overlap ON patient_itinerary_absence;
CREATE TRIGGER trg_patient_itinerary_absence_3_no_overlap
  BEFORE INSERT OR UPDATE OF substitute_worker_id, cancelled_at ON patient_itinerary_absence
  FOR EACH ROW EXECUTE FUNCTION fn_patient_itinerary_absence_no_overlap();
