-- Migration 162: rollback das migrations 155+156 (que dropparam service_lat/lng/location de job_postings).
--
-- Contexto:
--   Reverte para o schema esperado pelo deploy worker-functions-00225-5xs (codigo de
--   1e68152, anterior ao refactor de 2026-05-06). Esse codigo le service_lat,
--   service_lng e service_location em job_postings; sem essas colunas o servico quebra.
--
-- Migrations aditivas mantidas (nao revertidas):
--   - 153/154: patient_addresses.lat/lng — colunas extras, codigo antigo ignora
--   - 157: patient_addresses.complement — coluna extra, codigo antigo ignora
--   - 158: worker_service_areas.work_zone/interest_zone/data_source — colunas extras,
--     codigo antigo nao consulta worker_service_areas
--   - 159: dados em worker_service_areas — sem efeito no codigo antigo
--
-- Migration 160 (rename worker_locations -> _deprecated_20260506) e revertida pela 161.
--
-- Definicoes restauradas (referencia: migration 046):
--   - service_lat  DECIMAL(10,8)
--   - service_lng  DECIMAL(11,8)
--   - service_location GEOGRAPHY(POINT, 4326) GENERATED ALWAYS AS (...) STORED
--   - idx_job_postings_service_location GIST WHERE service_location IS NOT NULL

BEGIN;

-- 1. Recriar colunas de coordenadas
ALTER TABLE job_postings
  ADD COLUMN IF NOT EXISTS service_lat DECIMAL(10, 8),
  ADD COLUMN IF NOT EXISTS service_lng DECIMAL(11, 8);

-- 2. Backfill a partir de patient_addresses via FK (job_postings.patient_address_id)
DO $$
DECLARE
  rows_updated INT;
BEGIN
  UPDATE job_postings jp
     SET service_lat = pa.lat,
         service_lng = pa.lng
    FROM patient_addresses pa
   WHERE jp.patient_address_id = pa.id
     AND pa.lat IS NOT NULL
     AND pa.lng IS NOT NULL
     AND jp.service_lat IS NULL;

  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  RAISE NOTICE 'job_postings rows backfilled with service_lat/service_lng: %', rows_updated;
END $$;

-- 3. Recriar generated column service_location (GEOGRAPHY) a partir de service_lat/lng
ALTER TABLE job_postings
  ADD COLUMN IF NOT EXISTS service_location GEOGRAPHY(POINT, 4326)
    GENERATED ALWAYS AS (
      CASE
        WHEN service_lat IS NOT NULL AND service_lng IS NOT NULL
        THEN ST_MakePoint(service_lng, service_lat)::geography
      END
    ) STORED;

-- 4. Recriar indice GiST (parcial: WHERE service_location IS NOT NULL)
CREATE INDEX IF NOT EXISTS idx_job_postings_service_location
  ON job_postings USING GIST (service_location)
  WHERE service_location IS NOT NULL;

COMMENT ON COLUMN job_postings.service_lat      IS 'Latitude do endereco de atendimento — restaurada via migration 162 (rollback das 155/156).';
COMMENT ON COLUMN job_postings.service_lng      IS 'Longitude do endereco de atendimento — restaurada via migration 162 (rollback das 155/156).';
COMMENT ON COLUMN job_postings.service_location IS 'Ponto geografico gerado de service_lat/lng — restaurado via migration 162 (rollback das 155/156).';

COMMIT;
