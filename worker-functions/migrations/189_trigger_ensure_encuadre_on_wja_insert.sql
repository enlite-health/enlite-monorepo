-- Migration 189: Trigger anti-órfã + índice composto (TD-036 Fase 2)
--
-- Garante invariante: toda WJA tem encuadre correspondente.
-- Defesa em camadas — call sites que já criam encuadre não são afetados
-- (ON CONFLICT DO NOTHING preserva o encuadre rico do call site).
--
-- Rollback: ver runbook TD-036 — remover trigger, função e índice via psql.

CREATE INDEX IF NOT EXISTS idx_encuadres_worker_job
  ON encuadres(worker_id, job_posting_id);

CREATE OR REPLACE FUNCTION fn_ensure_encuadre_on_wja_insert()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.worker_id IS NOT NULL AND NEW.job_posting_id IS NOT NULL THEN
    INSERT INTO encuadres (worker_id, job_posting_id, import_source_audit, dedup_hash)
    SELECT
      NEW.worker_id,
      NEW.job_posting_id,
      'auto-trigger',
      md5('auto-trigger|' || NEW.worker_id::text || '|' || NEW.job_posting_id::text)
    WHERE NOT EXISTS (
      SELECT 1 FROM encuadres e
      WHERE e.worker_id = NEW.worker_id
        AND e.job_posting_id = NEW.job_posting_id
    )
    ON CONFLICT (dedup_hash) DO NOTHING;

    IF FOUND THEN
      RAISE NOTICE 'auto-trigger encuadre created for WJA worker=% job=%',
        NEW.worker_id, NEW.job_posting_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ensure_encuadre_on_wja_insert ON worker_job_applications;
CREATE TRIGGER trg_ensure_encuadre_on_wja_insert
  AFTER INSERT ON worker_job_applications
  FOR EACH ROW
  EXECUTE FUNCTION fn_ensure_encuadre_on_wja_insert();
