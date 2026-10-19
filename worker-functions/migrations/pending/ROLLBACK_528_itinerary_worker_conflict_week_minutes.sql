-- Volta da 528: restaura a trava por prestador por weekday + minutos do dia (corpos LITERAIS de mig/484:216-464).
-- Rodar JUNTO do ROLLBACK_527, numa transação só: psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f ROLLBACK_528... -f ROLLBACK_527...
-- check_function_bodies=off: o corpo SQL antigo lê end_time, que só volta no ROLLBACK_527.
SET LOCAL check_function_bodies = off;

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

DROP FUNCTION IF EXISTS itinerary_worker_conflict(UUID, int4multirange, UUID, DATE, DATE, UUID, UUID, UUID);
DROP FUNCTION IF EXISTS itinerary_week_minutes_expand(int4multirange, integer);
