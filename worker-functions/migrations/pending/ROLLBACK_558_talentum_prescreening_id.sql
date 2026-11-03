DROP INDEX IF EXISTS uq_job_postings_talentum_prescreening_id;
ALTER TABLE job_postings DROP COLUMN IF EXISTS talentum_prescreening_id;
