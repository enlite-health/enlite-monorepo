-- Migration 250: soft-dismiss de tentativas bloqueadas ("Rechazar" no kanban)
--
-- Um card da coluna BLOQUEADO não pode virar candidatura real: o trigger 183
-- (enforce_worker_registered_for_application) proíbe worker_job_applications de
-- worker não-REGISTERED, e todo bloqueado é não-REGISTERED por definição. Então
-- "Rechazar" um bloqueado NÃO cria WJA — marca a tentativa como descartada, com
-- motivo. O card sai de BLOQUEADO e aparece em RECHAZADOS como card de bloqueado
-- (não-arrastável, coerente com o fato de um incompleto não poder andar no funil).
-- Reversível: "voltar a bloqueados" limpa dismissed_at.

ALTER TABLE worker_blocked_applications
  ADD COLUMN IF NOT EXISTS dismissed_at     TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS dismissed_reason VARCHAR(30) NULL;

COMMENT ON COLUMN worker_blocked_applications.dismissed_at IS
  'Quando o operador "rechazou" a tentativa no kanban (soft-dismiss). NULL = ativa na coluna BLOQUEADO.';
COMMENT ON COLUMN worker_blocked_applications.dismissed_reason IS
  'Categoria do motivo do rechazo (mesmo enum de encuadres.rejection_reason_category). NULL quando não rechazada.';

DO $$ BEGIN
  RAISE NOTICE 'Migration 250 complete: dismissed_at + dismissed_reason em worker_blocked_applications';
END $$;
