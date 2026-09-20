-- 272: índices compostos liderados por country nas listagens quentes (ABAC país Fase 1)
--
-- Quando a RLS de país entrar (role app_runtime), toda listagem staff ganha o
-- predicado `country = current_setting(...)`. Estes índices casam com as queries do
-- baseline 1.4 da change (openspec/changes/abac-pais-fase1/baseline-1.4.md):
--   patients:     lista admin ordena por created_at DESC com deleted_at IS NULL (Q5);
--   workers:      dashboard conta por status com merged_into_id IS NULL (D4);
--   job_postings: dashboard/zonas filtram por country + status em vaga viva (4a/Z1).
-- Volumetria atual (13/08: workers 7.5k · patients 384 · job_postings 508) permite
-- CREATE INDEX comum — o runner roda cada migration numa transação, então CONCURRENTLY
-- não é opção aqui; em volumes futuros, criar fora do runner.

CREATE INDEX IF NOT EXISTS idx_patients_country_created_at
  ON patients (country, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_workers_country_status
  ON workers (country, status)
  WHERE merged_into_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_job_postings_country_status
  ON job_postings (country, status)
  WHERE deleted_at IS NULL;
