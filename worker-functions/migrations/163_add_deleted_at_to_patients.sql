-- ============================================================
-- Migration 163: patients.deleted_at — soft delete via webhook ClickUp
-- ============================================================
-- Disparado quando ClickUp envia evento taskDeleted.
-- NÃO confundir com status='DISCONTINUED' (semântica clínica = baixa do
-- tratamento). taskDeleted = task removida do ClickUp por engano ou
-- limpeza administrativa, sem ato clínico.
-- ============================================================

ALTER TABLE patients ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

COMMENT ON COLUMN patients.deleted_at IS
  'Soft-delete vindo de evento taskDeleted do ClickUp. Distinto de status=DISCONTINUED (que é ato clínico).';

CREATE INDEX IF NOT EXISTS patients_deleted_at_idx
  ON patients(deleted_at)
  WHERE deleted_at IS NOT NULL;

DO $$ BEGIN RAISE NOTICE 'Migration 163: patients.deleted_at adicionado'; END $$;
