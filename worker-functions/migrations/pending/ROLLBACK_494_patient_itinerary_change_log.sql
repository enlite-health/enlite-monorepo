-- ROLLBACK_494_patient_itinerary_change_log.sql — par de rollback da migration 494
-- (registro de trocas do itinerário, change itinerario-trocas-motivos-e-figma, Fase 2).
--
-- Mora em `migrations/pending/` (sem número): o runner só lê `migrations/` sem recursão. Só roda quando
-- alguém aponta o caminho explicitamente:
--   ./scripts/run-migration-prod.sh worker-functions/migrations/pending/ROLLBACK_494_patient_itinerary_change_log.sql
--
-- Trava de dado: se já existe QUALQUER registro de troca, o rollback apagaria o histórico — recusa.

DO $$
BEGIN
  IF to_regclass('public.patient_itinerary_change_log') IS NOT NULL THEN
    IF (SELECT count(*) FROM patient_itinerary_change_log) > 0 THEN
      RAISE EXCEPTION 'há registro de troca — o rollback apagaria o histórico (OK do Gabriel antes)';
    END IF;
  END IF;
END $$;

DROP TABLE IF EXISTS patient_itinerary_change_log;
DROP FUNCTION IF EXISTS fn_picl_country_from_service();
