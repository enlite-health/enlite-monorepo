-- 558 — `job_postings.talentum_prescreening_id`: o `_id` do prescreening da Talentum v2 (webhook `data.prescreening.id`).
-- Medido em prd: `data.prescreening.id` ≠ `talentum_project_id` em 98%. A ligação certa é
-- `GET /projects/{talentum_project_id}/prescreening` → `_id` (247/248 vagas casam). Sem GET reverso, o `_id` precisa
-- ficar gravado na vaga para o webhook PRESCREENING_RESPONSE achar a vaga OFICIAL (não o rascunho do mesmo paciente).
-- Coluna nullable (preenchida pelo publish/sync e pelo backfill `scripts/backfill-talentum-prescreening-id.ts`).
-- Índice único parcial: um prescreening ↔ no máximo uma vaga VIVA. Idempotente; só DDL de dono (roda como enlite_app).
ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS talentum_prescreening_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_job_postings_talentum_prescreening_id
  ON job_postings (talentum_prescreening_id)
  WHERE talentum_prescreening_id IS NOT NULL AND deleted_at IS NULL;
COMMENT ON COLUMN job_postings.talentum_prescreening_id IS
  '`_id` do prescreening na Talentum v2 (= data.prescreening.id do webhook). NÃO é talentum_project_id.';
