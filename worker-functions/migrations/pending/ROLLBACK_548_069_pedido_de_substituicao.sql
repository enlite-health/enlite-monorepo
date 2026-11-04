-- ROLLBACK_548_069_pedido_de_substituicao.sql — par de rollback da migration 548 (spec 069).
--
-- Mora em `migrations/pending/` (sem número): o runner só lê `migrations/` sem recursão. Só roda quando alguém aponta o caminho:
--   ./scripts/run-migration-prod.sh worker-functions/migrations/pending/ROLLBACK_548_069_pedido_de_substituicao.sql
--
-- Trava de dado: se já existe QUALQUER pedido gravado, o rollback apagaria o vínculo ausência/registro → pedido — recusa.
-- Restaura o corpo LITERAL de `fn_patient_itinerary_absence_no_overlap()` da 528 (a montagem própria dos argumentos).
-- Não remove a linha de `notification_types` nem o índice `uq_notifications_event_recipient` se houver notificação do tipo
-- (o índice é aditivo e inofensivo; a linha de tipo só sai se nenhum evento a usa).

DO $$
BEGIN
  IF to_regclass('public.patient_itinerary_substitution_request') IS NOT NULL THEN
    IF (SELECT count(*) FROM patient_itinerary_substitution_request) > 0 THEN
      RAISE EXCEPTION 'há pedido de substituição gravado — o rollback apagaria o vínculo com as ausências/registro (OK do Gabriel antes)';
    END IF;
  END IF;
  IF to_regclass('public.itinerary_uncovered_alert_dispatch') IS NOT NULL THEN
    IF (SELECT count(*) FROM itinerary_uncovered_alert_dispatch) > 0 THEN
      RAISE EXCEPTION 'há despacho do alerta diário gravado — o rollback apagaria o histórico (OK do Gabriel antes)';
    END IF;
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_picl_request ON patient_itinerary_change_log;
DROP FUNCTION IF EXISTS fn_picl_request();
ALTER TABLE patient_itinerary_change_log DROP CONSTRAINT IF EXISTS picl_request_by_kind;
ALTER TABLE patient_itinerary_change_log DROP CONSTRAINT IF EXISTS picl_request_fk;
ALTER TABLE patient_itinerary_change_log DROP COLUMN IF EXISTS request_id;

DROP TRIGGER IF EXISTS trg_patient_itinerary_absence_4_request ON patient_itinerary_absence;
DROP FUNCTION IF EXISTS fn_patient_itinerary_absence_request();
DROP INDEX IF EXISTS idx_piab_request;
ALTER TABLE patient_itinerary_absence DROP COLUMN IF EXISTS request_id;

DROP TABLE IF EXISTS itinerary_uncovered_alert_dispatch;
DROP TABLE IF EXISTS itinerary_daily_run;
DROP INDEX IF EXISTS uq_notifications_event_recipient;
DELETE FROM notification_types WHERE code = 'ITINERARY_UNCOVERED_SHIFTS'
  AND NOT EXISTS (SELECT 1 FROM notification_events e WHERE e.type_code = 'ITINERARY_UNCOVERED_SHIFTS');

DROP TABLE IF EXISTS patient_itinerary_substitution_request;
DROP FUNCTION IF EXISTS fn_pisr_desfazer();
DROP FUNCTION IF EXISTS fn_pisr_imutavel();
DROP FUNCTION IF EXISTS fn_pisr_country_from_service();

DROP FUNCTION IF EXISTS itinerary_substitute_conflict_preview(UUID, UUID, DATE, DATE, UUID);

-- corpo literal da 528 (monta week_minutes/address do slot e chama itinerary_worker_conflict)
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

DROP FUNCTION IF EXISTS itinerary_slot_worker_conflict(UUID, UUID, DATE, DATE, UUID);

