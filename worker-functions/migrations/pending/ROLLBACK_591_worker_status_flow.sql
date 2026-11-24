-- ROLLBACK_591_worker_status_flow.sql — par de rollback da migration 591 (spec 093).
--
-- Mora em `migrations/pending/` (sem número) porque o runner só lê `migrations/` sem recursão.
-- Só roda quando alguém aponta o caminho explicitamente:
--   ./scripts/run-migration-prod.sh worker-functions/migrations/pending/ROLLBACK_591_worker_status_flow.sql
--
-- Remove o trigger e a função de trava, devolve o corpo de fn_log_worker_status_change da 096 (sem flow) e apaga a coluna
-- worker_status_history.flow (e o CHECK, junto). Perde o fluxo já gravado; as demais colunas do history não mudam.
-- Ordem: trigger → função da trava → corpo antigo do log → coluna (o corpo novo do log referencia `flow`).

DROP TRIGGER IF EXISTS trg_worker_status_require_flow ON workers;
DROP FUNCTION IF EXISTS fn_worker_status_require_flow();

CREATE OR REPLACE FUNCTION fn_log_worker_status_change()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO worker_status_history (worker_id, field_name, old_value, new_value, changed_by)
    VALUES (NEW.id, 'status', OLD.status, NEW.status,
            current_setting('app.current_uid', true));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE worker_status_history DROP CONSTRAINT IF EXISTS worker_status_history_flow_check;
ALTER TABLE worker_status_history DROP COLUMN IF EXISTS flow;
