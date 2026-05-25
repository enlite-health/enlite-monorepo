-- ============================================================
-- Migration 193: UNIQUE (worker_id, job_posting_id) em encuadres
-- ============================================================
-- Pré-condição: Migration 192 executada com sucesso (zero duplicatas).
-- Ordem de deploy (refinada 2026-05-24 vs ADR-001 original):
--   1. Migration 192 (consolidação)
--   2. Migration 193 (esta — UNIQUE + trigger 189 atualizado)
--   3. Code deploy (6 call sites com novo ON CONFLICT target)
-- ============================================================

BEGIN;

-- Verificação de pré-condição
DO $$
DECLARE dup_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO dup_count
  FROM (
    SELECT worker_id, job_posting_id FROM encuadres
    WHERE worker_id IS NOT NULL AND job_posting_id IS NOT NULL
    GROUP BY worker_id, job_posting_id HAVING COUNT(*) > 1
  ) t;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'Pré-condição falhou: % pares com duplicatas. Rodar Migration 192 primeiro.', dup_count;
  END IF;
END $$;

-- UNIQUE constraint composta (idempotente via DO block)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'encuadres'::regclass
      AND conname = 'encuadres_worker_job_unique'
  ) THEN
    ALTER TABLE encuadres
      ADD CONSTRAINT encuadres_worker_job_unique
      UNIQUE (worker_id, job_posting_id);
  END IF;
END $$;

-- Atualizar trigger 189: ON CONFLICT (dedup_hash) → ON CONFLICT (worker_id, job_posting_id)
-- (Race condition: dois triggers concorrentes com hashes diferentes pro mesmo par violariam
--  a nova UNIQUE composta se ON CONFLICT alvejasse dedup_hash. Atualizando aqui na mesma
--  migration garante atomicidade entre constraint e trigger.)
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
      WHERE e.worker_id = NEW.worker_id AND e.job_posting_id = NEW.job_posting_id
    )
    ON CONFLICT (worker_id, job_posting_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;
