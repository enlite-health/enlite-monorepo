-- Migration 197: F8 — Rename encuadres.origen → encuadres.import_source_audit
-- Justificativa: ADR-002 fase F8. encuadres.origen NUNCA teve authority de classificação
-- de origem (SSOT é worker_job_applications.source). Coluna serve apenas como auditoria
-- de origem de import histórico ('Talentum', 'ClickUp', 'auto-trigger', 'talent_search',
-- 'site', 'backfill-td036', etc.). Rename torna a semântica explícita.

BEGIN;

-- Pré-check: confirmar que coluna ainda existe (idempotência defensiva)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'encuadres' AND column_name = 'origen'
  ) THEN
    ALTER TABLE encuadres RENAME COLUMN origen TO import_source_audit;
    RAISE NOTICE 'Migration 197: encuadres.origen renomeado para import_source_audit';
  ELSE
    RAISE NOTICE 'Migration 197: encuadres.origen não existe — pulando rename (já executado?)';
  END IF;
END $$;

-- Atualizar comentário da coluna
COMMENT ON COLUMN encuadres.import_source_audit IS
  'Auditoria de origem de import histórico (Talentum, ClickUp, auto-trigger, talent_search, site, etc.). '
  'NUNCA é SSOT de origem da candidatura — SSOT real é worker_job_applications.source. '
  'F8 (2026-05-25, ADR-002): renomeado de "origen" para deixar a semântica explícita.';

COMMIT;
