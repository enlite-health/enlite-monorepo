-- 528 — a trava por prestador passa a comparar minutos da SEMANA (turno noturno e 24 h; spec 056 §4.2 (a)).
-- Mesma regra de 482/484: mesmo endereço → não sobrepor; endereço diferente ou NULL → folga itinerary_min_gap_minutes().
-- DETAIL do 23P01 com as MESMAS 10 chaves (itineraryOverlap.ts lê sem mudança); fim = início + duração.
-- Sobe JUNTO da 527 (que apagou end_time). Idempotente. Rollback: pending/ROLLBACK_528_itinerary_worker_conflict_week_minutes.sql.

CREATE OR REPLACE FUNCTION itinerary_week_minutes_expand(p_minutes int4multirange, p_gap integer)
RETURNS int4multirange
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT COALESCE(range_agg(x), '{}'::int4multirange)
    FROM unnest(p_minutes) AS r,
         LATERAL unnest(itinerary_week_range(lower(r) - p_gap, upper(r) - lower(r) + 2 * p_gap)) AS x
$$;

CREATE OR REPLACE FUNCTION itinerary_worker_conflict(
  p_worker            UUID,
  p_week_minutes      int4multirange,
  p_address           UUID,
  p_from              DATE,
  p_to                DATE,
  p_ignore_assignment UUID,
  p_ignore_absence    UUID,
  p_open_pair_slot    UUID
)
RETURNS TABLE (service_id UUID, weekday SMALLINT, start_time TIME, duration_minutes INTEGER, address_id UUID)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  SELECT c.service_id, c.weekday, c.start_time, c.duration_minutes, c.address_id
    FROM (
      SELECT s2.contracted_service_id AS service_id, s2.weekday, s2.start_time, s2.duration_minutes,
             s2.week_minutes, pcs2.address_id AS address_id
        FROM patient_itinerary_assignment a
        JOIN patient_itinerary_slot s2 ON s2.id = a.slot_id
        JOIN patient_contracted_services pcs2 ON pcs2.id = s2.contracted_service_id
       WHERE a.worker_id = p_worker
         AND a.status = 'ACTIVE'
         AND a.id IS DISTINCT FROM p_ignore_assignment
         AND NOT (p_open_pair_slot IS NOT NULL AND a.slot_id = p_open_pair_slot
                  AND a.valid_to IS NULL AND p_to IS NULL)
         AND a.valid_from <= COALESCE(p_to, 'infinity'::date)
         AND COALESCE(a.valid_to, 'infinity'::date) >= p_from
      UNION ALL
      SELECT s3.contracted_service_id, s3.weekday, s3.start_time, s3.duration_minutes,
             s3.week_minutes, pcs3.address_id
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
    ) AS c, (SELECT itinerary_min_gap_minutes() AS v_gap) AS g
   WHERE (c.address_id IS NOT NULL AND c.address_id = p_address
          AND c.week_minutes && p_week_minutes)
      OR (NOT (c.address_id IS NOT NULL AND c.address_id = p_address)
          AND c.week_minutes && itinerary_week_minutes_expand(p_week_minutes, g.v_gap))
   ORDER BY c.weekday, c.start_time
   LIMIT 1
$$;
REVOKE ALL ON FUNCTION itinerary_worker_conflict(UUID, int4multirange, UUID, DATE, DATE, UUID, UUID, UUID) FROM PUBLIC;

CREATE OR REPLACE FUNCTION fn_patient_itinerary_assignment_no_overlap()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  v_gap INT := itinerary_min_gap_minutes();
  v_weekday SMALLINT; v_start_time TIME; v_duration INT; v_minutes int4multirange;
  v_service_id UUID; v_address_id UUID;
  v_c_service_id UUID; v_c_weekday SMALLINT; v_c_start_time TIME; v_c_duration INT; v_c_address_id UUID;
  v_same_address BOOLEAN;
BEGIN
  IF NEW.status IS DISTINCT FROM 'ACTIVE' THEN RETURN NEW; END IF;
  IF NEW.slot_id IS NULL OR NEW.worker_id IS NULL OR NEW.valid_from IS NULL THEN RETURN NEW; END IF;
  IF NEW.valid_to IS NOT NULL AND NEW.valid_to < NEW.valid_from THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('itinerary:worker:' || NEW.worker_id::text));
  SELECT s.weekday, s.start_time, s.duration_minutes, s.week_minutes, s.contracted_service_id, pcs.address_id
    INTO v_weekday, v_start_time, v_duration, v_minutes, v_service_id, v_address_id
    FROM patient_itinerary_slot s
    JOIN patient_contracted_services pcs ON pcs.id = s.contracted_service_id
   WHERE s.id = NEW.slot_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT * INTO v_c_service_id, v_c_weekday, v_c_start_time, v_c_duration, v_c_address_id
    FROM itinerary_worker_conflict(NEW.worker_id, v_minutes, v_address_id, NEW.valid_from, NEW.valid_to, NEW.id, NULL, NEW.slot_id);
  IF NOT FOUND THEN RETURN NEW; END IF;
  v_same_address := (v_address_id IS NOT NULL AND v_c_address_id = v_address_id);
  RAISE EXCEPTION 'itinerary_overlap' USING
    ERRCODE = '23P01',
    DETAIL = json_build_object(
      'existingServiceId', v_c_service_id,
      'existingWeekday', v_c_weekday,
      'existingStart', to_char(v_c_start_time, 'HH24:MI'),
      'existingEnd', to_char(v_c_start_time + make_interval(mins => v_c_duration), 'HH24:MI'),
      'requestedServiceId', v_service_id,
      'requestedWeekday', v_weekday,
      'requestedStart', to_char(v_start_time, 'HH24:MI'),
      'requestedEnd', to_char(v_start_time + make_interval(mins => v_duration), 'HH24:MI'),
      'sameAddress', v_same_address,
      'minGapMinutes', CASE WHEN v_same_address THEN NULL ELSE v_gap END
    )::text;
END;
$$;
REVOKE ALL ON FUNCTION fn_patient_itinerary_assignment_no_overlap() FROM PUBLIC;

CREATE OR REPLACE FUNCTION fn_patient_itinerary_absence_no_overlap()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  v_gap INT := itinerary_min_gap_minutes();
  v_weekday SMALLINT; v_start_time TIME; v_duration INT; v_minutes int4multirange;
  v_service_id UUID; v_address_id UUID;
  v_c_service_id UUID; v_c_weekday SMALLINT; v_c_start_time TIME; v_c_duration INT; v_c_address_id UUID;
  v_same_address BOOLEAN;
BEGIN
  IF NEW.substitute_worker_id IS NULL OR NEW.cancelled_at IS NOT NULL THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('itinerary:worker:' || NEW.substitute_worker_id::text));
  SELECT s.weekday, s.start_time, s.duration_minutes, s.week_minutes, s.contracted_service_id, pcs.address_id
    INTO v_weekday, v_start_time, v_duration, v_minutes, v_service_id, v_address_id
    FROM patient_itinerary_assignment a
    JOIN patient_itinerary_slot s ON s.id = a.slot_id
    JOIN patient_contracted_services pcs ON pcs.id = s.contracted_service_id
   WHERE a.id = NEW.assignment_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT * INTO v_c_service_id, v_c_weekday, v_c_start_time, v_c_duration, v_c_address_id
    FROM itinerary_worker_conflict(NEW.substitute_worker_id, v_minutes, v_address_id, NEW.on_date, NEW.on_date, NULL, NEW.id, NULL);
  IF NOT FOUND THEN RETURN NEW; END IF;
  v_same_address := (v_address_id IS NOT NULL AND v_c_address_id = v_address_id);
  RAISE EXCEPTION 'itinerary_overlap' USING
    ERRCODE = '23P01',
    DETAIL = json_build_object(
      'existingServiceId', v_c_service_id,
      'existingWeekday', v_c_weekday,
      'existingStart', to_char(v_c_start_time, 'HH24:MI'),
      'existingEnd', to_char(v_c_start_time + make_interval(mins => v_c_duration), 'HH24:MI'),
      'requestedServiceId', v_service_id,
      'requestedWeekday', v_weekday,
      'requestedStart', to_char(v_start_time, 'HH24:MI'),
      'requestedEnd', to_char(v_start_time + make_interval(mins => v_duration), 'HH24:MI'),
      'sameAddress', v_same_address,
      'minGapMinutes', CASE WHEN v_same_address THEN NULL ELSE v_gap END
    )::text;
END;
$$;
REVOKE ALL ON FUNCTION fn_patient_itinerary_absence_no_overlap() FROM PUBLIC;

-- a assinatura antiga (lia end_time, que a 527 apagou) sai depois que ninguém a chama
DROP FUNCTION IF EXISTS itinerary_worker_conflict(UUID, SMALLINT, INT, INT, UUID, DATE, DATE, UUID, UUID, UUID);
