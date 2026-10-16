-- ROLLBACK_520_confirmed_stage_to_completed.sql — par de rollback da migration 520 (spec 052, Fase 4).
-- Mora em `migrations/pending/`; só roda quando alguém aponta o caminho. Só tem sentido JUNTO com a volta do código antigo (com o
-- código novo o estágio CONFIRMED não existe). Devolve a CONFIRMED apenas as candidaturas cujo ÚLTIMO histórico de estágio é o da
-- 520 (changed_by = 'system:migration-520') e que ainda estão em COMPLETED; quem foi movido depois fica onde está.
-- NÃO desfaz o cancelamento dos convites `qualified_worker_request` (a fila não guarda o estado anterior de forma recuperável).
-- Antes: SELECT count(*) FROM worker_job_application_stage_history WHERE changed_by = 'system:migration-520';
BEGIN;
SELECT set_config('app.bypass_registered_guard', 'on', true);
SELECT set_config('app.current_uid', 'system:rollback-520', true);

UPDATE worker_job_applications wja
SET application_funnel_stage = 'CONFIRMED'
FROM (
  SELECT DISTINCT ON (application_id) application_id, changed_by
  FROM worker_job_application_stage_history
  WHERE field_name = 'application_funnel_stage'
  ORDER BY application_id, created_at DESC, id DESC
) ultimo
WHERE ultimo.application_id = wja.id
  AND ultimo.changed_by = 'system:migration-520'
  AND wja.application_funnel_stage = 'COMPLETED';
COMMIT;
