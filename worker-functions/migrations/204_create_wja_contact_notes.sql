CREATE TABLE wja_contact_notes (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_job_application_id UUID        NOT NULL
    REFERENCES worker_job_applications(id) ON DELETE CASCADE,
  note_text                 VARCHAR(240) NOT NULL
    CHECK (length(trim(note_text)) > 0),
  created_by_admin_id       TEXT        NOT NULL,
  created_by_admin_email    TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_wja_contact_notes_wja
  ON wja_contact_notes(worker_job_application_id, created_at DESC);
COMMENT ON TABLE wja_contact_notes IS 'Log append-only de notas manuais de contato por operadora, escopadas ao par candidato×vaga (WJA).';
COMMENT ON COLUMN wja_contact_notes.created_by_admin_id IS 'Firebase UID da operadora. Denormalizado — não FK pra users.';
