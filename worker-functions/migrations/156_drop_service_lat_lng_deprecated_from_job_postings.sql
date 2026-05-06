-- Migration 156 — Drop deprecated service_lat/lng/location columns and GiST index
-- from job_postings (renamed by migration 155).
--
-- Safe to apply because:
--   - Coordinates are now in patient_addresses.lat/lng (migration 153/154).
--   - Distance computation in VacancyMatchController uses JOIN with patient_addresses
--     and ST_MakePoint(pa.lng, pa.lat) instead of jp.service_location.
--   - MatchmakingService.loadJob joins patient_addresses for lat/lng.
--   - grep -rn "service_lat|service_lng|service_location" src/ returns empty after Fase 0.
--
-- Drop order: index → generated column → source columns.

DROP INDEX IF EXISTS idx_job_postings_service_location_deprecated_20260501;

ALTER TABLE job_postings
  DROP COLUMN IF EXISTS service_location_deprecated_20260501,
  DROP COLUMN IF EXISTS service_lat_deprecated_20260501,
  DROP COLUMN IF EXISTS service_lng_deprecated_20260501;
