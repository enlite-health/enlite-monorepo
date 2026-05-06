-- Migration 155 — Rename job_postings.service_lat/service_lng/service_location
-- and the associated GiST index to _deprecated_20260501.
--
-- Rationale: coordinates belong to the address entity, not the vacancy.
-- SPRINT_VACANCIES_REFACTOR Decision 4.1: "vaga é derivada de paciente, sem duplicação".
-- lat/lng added to patient_addresses (migration 153) and backfilled (migration 154).
-- service_location is a generated column derived from service_lat/lng — also deprecated.
-- Application code updated in Fase 0:
--   - MatchmakingService.loadJob: reads lat/lng via JOIN patient_addresses
--   - VacancyMatchController.getMatchResults: distance via ST_MakePoint(pa.lng, pa.lat)
-- Following: migration 156 drops the _deprecated_ columns and index.

DO $$
BEGIN
  -- Rename GiST index before renaming/dropping the columns it references
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_job_postings_service_location') THEN
    ALTER INDEX idx_job_postings_service_location
      RENAME TO idx_job_postings_service_location_deprecated_20260501;
  END IF;

  -- Rename generated column (depends on service_lat/lng — must go before them)
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'job_postings' AND column_name = 'service_location') THEN
    ALTER TABLE job_postings RENAME COLUMN service_location TO service_location_deprecated_20260501;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'job_postings' AND column_name = 'service_lat') THEN
    ALTER TABLE job_postings RENAME COLUMN service_lat TO service_lat_deprecated_20260501;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'job_postings' AND column_name = 'service_lng') THEN
    ALTER TABLE job_postings RENAME COLUMN service_lng TO service_lng_deprecated_20260501;
  END IF;
END;
$$;
