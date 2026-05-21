-- 180_add_timezone_to_job_postings.sql
-- Adiciona timezone IANA por vaga pra suportar multi-país sem hardcode
ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS timezone TEXT;

UPDATE job_postings SET timezone = CASE
  WHEN country = 'AR' THEN 'America/Argentina/Buenos_Aires'
  WHEN country = 'BR' THEN 'America/Sao_Paulo'
  ELSE 'UTC'
END
WHERE timezone IS NULL;

ALTER TABLE job_postings ALTER COLUMN timezone SET NOT NULL;
ALTER TABLE job_postings ALTER COLUMN timezone SET DEFAULT 'America/Argentina/Buenos_Aires';
