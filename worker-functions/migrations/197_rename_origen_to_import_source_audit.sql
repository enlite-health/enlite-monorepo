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

-- Recriar função do trigger 189/193 com o nome novo da coluna
-- (CREATE OR REPLACE FUNCTION é seguro; a função usa o nome antigo internamente)
CREATE OR REPLACE FUNCTION fn_ensure_encuadre_on_wja_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
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
      WHERE e.worker_id = NEW.worker_id AND e.job_posting_id = NEW.job_posting_id
    )
    ON CONFLICT (worker_id, job_posting_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$function$;

COMMIT;
