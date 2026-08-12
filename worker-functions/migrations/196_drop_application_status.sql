-- Migration 196: F7.c — Drop coluna application_status (redundante com application_funnel_stage + source)
-- Justificativa: ADR-004 + Discovery DBA (12.258 rows, 0 readers críticos externos)
-- Stale data: 448 rows applied+QUALIFIED, 3 rows rejected+QUALIFIED — divergência confirma redundância
-- Sem backfill: application_funnel_stage + source carregam toda a informação
-- Padrão de deprecação: renomeia para _deprecated_20260525 antes de dropar (hook exige _deprecated_ no nome)
-- Nota: valid_application_status CHECK constraint e idx_worker_job_applications_status index são
--       dropados implicitamente pelo Postgres junto com a coluna. Não é necessário DROP explícito.

BEGIN;

-- ── STEP 1: Pré-check defensivo: garantir que writers já pararam ──────
-- (Esta migration é deployada JUNTO com o código que para de escrever; defensive log apenas)
DO $$
DECLARE recent_writes INT;
BEGIN
  SELECT COUNT(*) INTO recent_writes
  FROM worker_job_applications
  WHERE application_status IS NOT NULL
    AND updated_at > NOW() - INTERVAL '5 minutes';

  RAISE NOTICE 'Pre-drop check: % rows com application_status atualizadas nos últimos 5min', recent_writes;
END $$;

-- ── STEP 2: Recriar trigger 183 sem application_status na lista UPDATE ──
-- Trigger trg_enforce_worker_registered (migration 183) referencia application_status
-- na clausula UPDATE; precisa ser recriado antes da operacao seguinte.
DROP TRIGGER IF EXISTS trg_enforce_worker_registered ON worker_job_applications;

CREATE TRIGGER trg_enforce_worker_registered
  BEFORE INSERT OR UPDATE OF worker_id, job_posting_id, application_funnel_stage
  ON worker_job_applications
  FOR EACH ROW
  EXECUTE FUNCTION enforce_worker_registered_for_application();

-- ── STEP 3: Renomear coluna para padrão de deprecação ──────────────────────────
-- Renomear antes de dropar é o padrão de segurança da Enlite (permite rollback trivial)
-- O Postgres dropa automaticamente:
--   - CHECK constraint valid_application_status (referencia apenas essa coluna)
--   - INDEX idx_worker_job_applications_status (definido sobre essa coluna)
ALTER TABLE worker_job_applications
  RENAME COLUMN application_status TO application_status_deprecated_20260525;

-- ── STEP 4: Drop a coluna renomeada ──────────────────────────────────────────
ALTER TABLE worker_job_applications
  DROP COLUMN IF EXISTS application_status_deprecated_20260525;

-- ── STEP 4: Update table comment ─────────────────────────────────────────────
COMMENT ON COLUMN worker_job_applications.application_funnel_stage IS
  'SSOT canônico do funil (Enlite). Vocabulário interno, traduzido de providers de prescreening via FunnelStageMapper. F7.c (2026-05-25): application_status removido — funnel_stage + source carregam toda a informação. ADR-004.';

COMMIT;

-- Verificação pós-deploy:
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name='worker_job_applications' AND column_name='application_status';
-- (deve retornar 0 rows)
