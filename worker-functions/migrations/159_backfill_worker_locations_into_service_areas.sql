-- Migration 159: backfill de worker_locations → worker_service_areas
--
-- Pré-requisito: migration 158 (schema changes em worker_service_areas).
--
-- Estratégia:
--   1. Workers em worker_locations SEM row em worker_service_areas → INSERT
--      (lat/lng=NULL pois worker_locations nunca preenche essas colunas)
--   2. Workers com row em ambas → UPDATE preenche work_zone/interest_zone/data_source
--      a partir de worker_locations (mantém lat/lng existentes em worker_service_areas)
--   3. Normaliza country='BR' → 'AR' (default novo)

-- 1. Insert workers que só existem em worker_locations
INSERT INTO worker_service_areas (
  worker_id,
  latitude,
  longitude,
  radius_km,
  address_line,
  city,
  state,
  postal_code,
  country,
  work_zone,
  interest_zone,
  data_source
)
SELECT
  wl.worker_id,
  wl.lat,
  wl.lng,
  20,
  wl.address,
  wl.city,
  wl.state,
  wl.postal_code,
  COALESCE(NULLIF(wl.country, ''), 'AR'),
  wl.work_zone,
  wl.interest_zone,
  wl.data_source
FROM worker_locations wl
WHERE NOT EXISTS (
  SELECT 1 FROM worker_service_areas wsa WHERE wsa.worker_id = wl.worker_id
);

-- 2. Update workers já existentes em service_areas com os campos legados
UPDATE worker_service_areas wsa
   SET work_zone     = COALESCE(wsa.work_zone,     wl.work_zone),
       interest_zone = COALESCE(wsa.interest_zone, wl.interest_zone),
       data_source   = COALESCE(wsa.data_source,   wl.data_source)
  FROM worker_locations wl
 WHERE wsa.worker_id = wl.worker_id
   AND (wsa.work_zone IS NULL OR wsa.interest_zone IS NULL OR wsa.data_source IS NULL);

-- 3. Normaliza country (era default 'BR' herdado de testes antigos)
UPDATE worker_service_areas SET country = 'AR' WHERE country = 'BR' OR country IS NULL;
