-- 248_add_is_test_to_job_postings.sql
-- Adds an "is_test" guard flag to job_postings so operators can create
-- throwaway/QA vacancies without triggering the auto-invite pipeline
-- (VacancyAutoInviteHandler on the `vacancy.created` domain event), which
-- would otherwise generate real WorkerJobApplications (WJA) and dispatch
-- real WhatsApp messages via messaging_outbox to real workers.
--
-- Aditiva: default false preserves current behaviour for every existing row.

ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false;
