-- Migration 154: backfill lat/lng into patient_addresses from job_postings
--
-- For each job_posting that has a patient_address_id + service_lat/service_lng,
-- copies the coordinates to the referenced patient_addresses row.
--
-- Conflict rule: if two job_postings point to the same patient_address_id with
-- different lat/lng values, the most recently updated job_posting wins
-- (ORDER BY jp.updated_at DESC in the subquery keeps the last-write).
-- This is acceptable because both values are approximations of the same address.

BEGIN;

DO $$
DECLARE
  before_count INT;
  after_count  INT;
  rows_updated INT;
BEGIN
  SELECT COUNT(*) INTO before_count
    FROM patient_addresses
   WHERE lat IS NOT NULL OR lng IS NOT NULL;
  RAISE NOTICE 'patient_addresses with lat/lng BEFORE backfill: %', before_count;

  -- Use DISTINCT ON to resolve conflicts: pick most-recently-updated job_posting
  -- per patient_address_id when multiple rows point to the same address.
  UPDATE patient_addresses pa
     SET lat = src.service_lat,
         lng = src.service_lng
    FROM (
      SELECT DISTINCT ON (jp.patient_address_id)
             jp.patient_address_id,
             jp.service_lat,
             jp.service_lng
        FROM job_postings jp
       WHERE jp.patient_address_id IS NOT NULL
         AND jp.service_lat IS NOT NULL
         AND jp.service_lng IS NOT NULL
       ORDER BY jp.patient_address_id, jp.updated_at DESC
    ) src
   WHERE pa.id  = src.patient_address_id
     AND pa.lat IS NULL;  -- fill-only: never overwrite existing coordinates

  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  RAISE NOTICE 'rows updated: %', rows_updated;

  SELECT COUNT(*) INTO after_count
    FROM patient_addresses
   WHERE lat IS NOT NULL OR lng IS NOT NULL;
  RAISE NOTICE 'patient_addresses with lat/lng AFTER backfill: %', after_count;
END $$;

COMMIT;
