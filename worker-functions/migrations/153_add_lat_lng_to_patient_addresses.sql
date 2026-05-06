-- Migration 153: add lat/lng columns to patient_addresses
--
-- Motivation: service_lat/service_lng in job_postings duplicates coordinate data
-- that logically belongs to the address, not the vacancy (SPRINT_VACANCIES_REFACTOR, Decision 4.1).
-- This migration adds the target columns before backfill (154) and drop (155).

ALTER TABLE patient_addresses
  ADD COLUMN IF NOT EXISTS lat NUMERIC(10,7),
  ADD COLUMN IF NOT EXISTS lng NUMERIC(10,7);

COMMENT ON COLUMN patient_addresses.lat IS 'Latitude geocodificada do endereço — migrada de job_postings.service_lat (migration 153/154)';
COMMENT ON COLUMN patient_addresses.lng IS 'Longitude geocodificada do endereço — migrada de job_postings.service_lng (migration 153/154)';
