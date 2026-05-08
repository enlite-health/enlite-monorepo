-- ============================================================
-- Migration 165: vacancy_relink_audit — auditoria de reconciliação de vagas órfãs
-- ============================================================
-- Quando o webhook ClickUp processa um paciente, ele faz:
--   UPDATE job_postings SET patient_id = ?
--   WHERE case_number = ? AND patient_id IS NULL
-- Cada UPDATE com affected_rows > 0 registra aqui pra rastreabilidade.
--
-- Crítico pra detectar relinks errados (ex: case_number digitado errado
-- linkando vaga ao paciente errado).
-- ============================================================

CREATE TABLE IF NOT EXISTS vacancy_relink_audit (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_posting_id  UUID NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE,
  case_number     INTEGER NOT NULL,
  old_patient_id  UUID,
  new_patient_id  UUID NOT NULL REFERENCES patients(id),
  source          VARCHAR(30) NOT NULL CHECK (source IN ('CLICKUP_WEBHOOK', 'CLICKUP_SYNC', 'MANUAL')),
  correlation_id  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS vacancy_relink_audit_job_posting_idx
  ON vacancy_relink_audit(job_posting_id);

CREATE INDEX IF NOT EXISTS vacancy_relink_audit_created_at_idx
  ON vacancy_relink_audit(created_at DESC);

COMMENT ON TABLE vacancy_relink_audit IS
  'Auditoria de reconciliação de vagas órfãs (job_postings.patient_id=NULL) → paciente recém-sincronizado via webhook ClickUp. Cada relink (UPDATE bem-sucedido) gera 1 linha aqui.';

COMMENT ON COLUMN vacancy_relink_audit.old_patient_id IS
  'NULL quando vaga estava órfã (caso esperado). UUID quando relink sobrescreveu link anterior (deve ser raríssimo, investigar quando ocorrer).';

COMMENT ON COLUMN vacancy_relink_audit.source IS
  'Origem do relink: CLICKUP_WEBHOOK (tempo real), CLICKUP_SYNC (script CLI batch), MANUAL (UPDATE direto via psql/admin).';

DO $$ BEGIN RAISE NOTICE 'Migration 165: vacancy_relink_audit criada'; END $$;
