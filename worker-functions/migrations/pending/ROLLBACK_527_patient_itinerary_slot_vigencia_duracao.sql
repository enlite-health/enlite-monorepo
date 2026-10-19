-- Volta da 527. Rodar DEPOIS do ROLLBACK_528. Recusa se o modelo antigo não representa o dado.
DO $$
BEGIN
  IF to_regclass('public.patient_itinerary_slot') IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM patient_itinerary_slot
              WHERE EXTRACT(HOUR FROM start_time)::int * 60 + EXTRACT(MINUTE FROM start_time)::int + duration_minutes > 1439) THEN
    RAISE EXCEPTION 'há faixa que passa da meia-noite ou de 24 h — o modelo antigo (end_time > start_time) não a representa (OK do Gabriel antes)';
  END IF;
  IF EXISTS (SELECT 1 FROM patient_itinerary_slot
              GROUP BY contracted_service_id, weekday, start_time, duration_minutes HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'a mesma chave existe em mais de uma vigência — pis_service_slot_uq recusaria (OK do Gabriel antes)';
  END IF;
END $$;
-- o JSONB volta a ser o dono: reescrito com as faixas vigentes hoje, sem `durationMinutes` (o zod antigo é .strict())
UPDATE patient_contracted_services pcs
   SET schedule = (SELECT jsonb_agg(x - 'durationMinutes')
                     FROM jsonb_array_elements(horario_do_servico(pcs.id, CURRENT_DATE)) AS x)
 WHERE EXISTS (SELECT 1 FROM patient_itinerary_slot s WHERE s.contracted_service_id = pcs.id);
ALTER TABLE patient_itinerary_slot DROP CONSTRAINT IF EXISTS pis_sem_sobreposicao;
DROP TRIGGER IF EXISTS trg_patient_itinerary_slot_key_immutable ON patient_itinerary_slot;
ALTER TABLE patient_itinerary_slot ADD COLUMN IF NOT EXISTS end_time time NULL;
ALTER TABLE patient_itinerary_slot ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
UPDATE patient_itinerary_slot
   SET end_time = start_time + make_interval(mins => duration_minutes),
       active = (NOT isempty(valid) AND upper_inf(valid));
ALTER TABLE patient_itinerary_slot ALTER COLUMN end_time SET NOT NULL;
ALTER TABLE patient_itinerary_slot ADD CONSTRAINT pis_time_order CHECK (end_time > start_time);
ALTER TABLE patient_itinerary_slot ADD CONSTRAINT pis_service_slot_uq UNIQUE (contracted_service_id, weekday, start_time, end_time);
ALTER TABLE patient_itinerary_slot DROP COLUMN IF EXISTS week_minutes;
ALTER TABLE patient_itinerary_slot DROP CONSTRAINT IF EXISTS pis_duration_range;
ALTER TABLE patient_itinerary_slot DROP CONSTRAINT IF EXISTS pis_valid_com_inicio;
ALTER TABLE patient_itinerary_slot DROP COLUMN IF EXISTS duration_minutes;
ALTER TABLE patient_itinerary_slot DROP COLUMN IF EXISTS valid;
CREATE OR REPLACE FUNCTION fn_patient_itinerary_slot_key_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF (NEW.contracted_service_id, NEW.weekday, NEW.start_time, NEW.end_time)
     IS DISTINCT FROM (OLD.contracted_service_id, OLD.weekday, OLD.start_time, OLD.end_time) THEN
    RAISE EXCEPTION 'pis_chave_imutavel' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_patient_itinerary_slot_key_immutable
  BEFORE UPDATE OF contracted_service_id, weekday, start_time, end_time ON patient_itinerary_slot
  FOR EACH ROW EXECUTE FUNCTION fn_patient_itinerary_slot_key_immutable();
DROP FUNCTION IF EXISTS horario_do_servico(uuid, date);
DROP FUNCTION IF EXISTS itinerary_slot_week_minutes(smallint, time, integer);
DROP FUNCTION IF EXISTS itinerary_week_range(integer, integer);
