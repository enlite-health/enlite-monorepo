-- Migration 213: promove workers COMPLETOS mas travados em INCOMPLETE_REGISTER.
--
-- Problema (revelado pela instrumentação de tentativas bloqueadas): workers em prod
-- têm fn_worker_missing_fields(id) = '[]' (completos pela política vigente) mas
-- status = 'INCOMPLETE_REGISTER' — então não conseguem postular mesmo prontos.
--
-- Causa: fn_guard_registered_status é um GATE (bloqueia a transição PARA REGISTERED
-- se faltar algo), não um PROMOTOR. recalculateStatus (app) só roda em evento explícito
-- (upload/save). Quem completou o cadastro via import/backfill ficou com status congelado.
--
-- Fix: promover quem está completo. A condição fn_worker_missing_fields = '[]' garante
-- que só completos são promovidos. O trigger fn_guard_registered_status revalida na
-- transição (completos → permite). Idempotente.
--
-- Resiliente: promove cada worker individualmente; se o trigger rejeitar algum (eventual
-- inconsistência fn vs trigger), pula com NOTICE em vez de abortar a migration inteira.
--
-- NOTA (causa raiz, followup): recalcular status quando a completude muda fora do app
-- (import/backfill) — job periódico ou recálculo no import.

DO $$
DECLARE
  r RECORD;
  promoted INT := 0;
  skipped INT := 0;
BEGIN
  FOR r IN
    SELECT id FROM workers
    WHERE status = 'INCOMPLETE_REGISTER'
      AND merged_into_id IS NULL
      AND fn_worker_missing_fields(id) = '[]'::jsonb
  LOOP
    BEGIN
      UPDATE workers SET status = 'REGISTERED', updated_at = NOW() WHERE id = r.id;
      promoted := promoted + 1;
    EXCEPTION WHEN OTHERS THEN
      skipped := skipped + 1;
      RAISE NOTICE 'mig213 skip worker % : %', r.id, SQLERRM;
    END;
  END LOOP;
  RAISE NOTICE 'mig213: promovidos=% pulados=%', promoted, skipped;
END $$;
