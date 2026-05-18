-- 168_add_is_draft_to_job_postings.sql
--
-- Adds explicit `is_draft` flag to job_postings. A vacancy is draft while the
-- operator has not finished the full publication flow (Talentum). Decouples
-- "draft" from any single channel — previously the absence of
-- talentum_published_at was used as an implicit proxy, which conflated
-- "incomplete" with "Talentum-specific" and made future publication channels
-- harder to model.
--
-- Rules enforced by this column (in code):
--   - Vacancies are created with is_draft = true (default).
--   - PublishVacancyToTalentumUseCase.publish() flips it to false.
--   - PublishVacancyToTalentumUseCase.unpublish() flips it back to true.
--   - PublicJobsQueryBuilder filters out drafts from the public listing.
--
-- Backfill: vacancies already published on Talentum keep their non-draft state.
-- All remaining rows (including the orphaned vacancies created via the legacy
-- form that never reached Talentum) inherit the default `true` and become
-- visible in the admin drafts list for the operator to resume.

ALTER TABLE job_postings
  ADD COLUMN IF NOT EXISTS is_draft BOOLEAN NOT NULL DEFAULT true;

UPDATE job_postings
   SET is_draft = false
 WHERE talentum_published_at IS NOT NULL
   AND is_draft = true;

-- Partial index — admin "drafts" view is the only frequent query that filters
-- by is_draft = true; the public listing filters by is_draft = false but is
-- already constrained by status + country + deleted_at, so a partial index on
-- the draft side is the more selective shape.
CREATE INDEX IF NOT EXISTS idx_job_postings_is_draft_true
  ON job_postings(is_draft) WHERE is_draft = true;

COMMENT ON COLUMN job_postings.is_draft IS
  'True while the vacancy has not completed the full publication flow. Flipped to false by PublishVacancyToTalentumUseCase.publish(). Drafts are hidden from the public listing and surface in the admin drafts queue.';
