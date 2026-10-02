-- 476 — `job_posting_notes`: anotação tipo CRM por vacante (cadeia-paciente-vacante-itinerario, Fase 3; 2026-09-23a#DEC-31).
-- Passo 0 (c): job_posting_comments (036) é import do ClickUp (stage: 120 linhas, todas source=clickup) e
-- wja_contact_notes (204) é por candidatura — nenhuma serve para "o que o time fez com a vacante".
-- Só acrescenta: app_runtime/app_system recebem SELECT e INSERT, sem UPDATE/DELETE (trilha).
-- O default privilege do schema public já concede arwd a app_runtime/app_system em toda
-- tabela nova (269_app_runtime_roles.sql:66-69, ALTER DEFAULT PRIVILEGES); por isso o
-- GRANT sozinho é aditivo e não basta — precisa do REVOKE abaixo para o append-only pegar
-- de verdade, mesmo molde do REVOKE UPDATE, DELETE que a 269 já aplica em
-- worker_job_application_stage_history (269:84-93) para deixá-la só `ar`.
-- `contact` e `body` são texto do perímetro: nunca a log, GBrain ou payload de agente.
-- Sem RLS: job_postings não tem (271:36, 413:12).
-- Rollback (down), só com a tabela vazia (fase-3.md §Rollback):
--   SELECT count(*) FROM job_posting_notes;   -- tem de dar 0; senão o rollback é só da tela
--   DROP TABLE IF EXISTS job_posting_notes;
CREATE TABLE IF NOT EXISTS job_posting_notes (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  job_posting_id  UUID         NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE,
  occurred_at     TIMESTAMPTZ  NOT NULL,
  category        TEXT         NOT NULL,
  contact         VARCHAR(120) NOT NULL,
  body            TEXT         NOT NULL,
  created_by      VARCHAR(128) NOT NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT jpn_category_check CHECK (category IN ('DIVULGACAO', 'CONTATO', 'OUTRO')),
  CONSTRAINT jpn_contact_check  CHECK (char_length(btrim(contact)) BETWEEN 1 AND 120),
  CONSTRAINT jpn_body_check     CHECK (char_length(btrim(body)) BETWEEN 1 AND 2000)
);
CREATE INDEX IF NOT EXISTS idx_job_posting_notes_posting_occurred
  ON job_posting_notes (job_posting_id, occurred_at DESC);
GRANT SELECT, INSERT ON job_posting_notes TO app_runtime, app_system;
REVOKE UPDATE, DELETE ON job_posting_notes FROM app_runtime, app_system;
