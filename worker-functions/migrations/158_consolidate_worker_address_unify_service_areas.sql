-- Migration 158: prepara worker_service_areas para consolidar com worker_locations
--
-- Contexto:
--   Existem duas tabelas com endereço/coords do worker:
--     - worker_locations    (legacy, importadores ClickUp): tem work_zone/interest_zone/data_source mas NUNCA preenche lat/lng
--     - worker_service_areas (flow do app via Maps): tem latitude/longitude reais mas só campos básicos
--   O match lê de worker_locations (sem coords) → ranking por distância nunca funcionou.
--
-- Esta migration:
--   1. Adiciona campos faltantes (work_zone, interest_zone, data_source) em worker_service_areas
--   2. Relaxa NOT NULL de latitude/longitude (workers do ClickUp ainda não têm coords)
--   3. Normaliza defaults: country='AR' (era 'BR'), radius_km=20 (era NOT NULL sem default)
--
-- Migration 159 faz o backfill dos dados.
-- Migration 160 dropa worker_locations.

ALTER TABLE worker_service_areas
  ADD COLUMN IF NOT EXISTS work_zone     TEXT,
  ADD COLUMN IF NOT EXISTS interest_zone TEXT,
  ADD COLUMN IF NOT EXISTS data_source   TEXT;

ALTER TABLE worker_service_areas
  ALTER COLUMN latitude  DROP NOT NULL,
  ALTER COLUMN longitude DROP NOT NULL;

ALTER TABLE worker_service_areas
  ALTER COLUMN country   SET DEFAULT 'AR',
  ALTER COLUMN radius_km SET DEFAULT 20;

COMMENT ON COLUMN worker_service_areas.work_zone     IS 'Zona de trabalho (texto livre — herdado de worker_locations.work_zone via migration 159)';
COMMENT ON COLUMN worker_service_areas.interest_zone IS 'Zona de interesse adicional (texto livre — herdado via migration 159)';
COMMENT ON COLUMN worker_service_areas.data_source   IS 'Fonte do dado (clickup/app/import — herdado via migration 159)';
COMMENT ON COLUMN worker_service_areas.latitude      IS 'Latitude geocodificada via Google Maps (nullable: workers de import legado podem não ter coords)';
COMMENT ON COLUMN worker_service_areas.longitude     IS 'Longitude geocodificada via Google Maps (nullable)';
