-- ROLLBACK da 518 (spec 027 Fase 3). Perde só o que foi gravado nas 7 colunas. Rodar manualmente, nunca pelo runner.
ALTER TABLE patient_contracted_services
  DROP COLUMN IF EXISTS required_professions,
  DROP COLUMN IF EXISTS required_sex,
  DROP COLUMN IF EXISTS required_experience,
  DROP COLUMN IF EXISTS worker_attributes,
  DROP COLUMN IF EXISTS work_schedule,
  DROP COLUMN IF EXISTS payment_day,
  DROP COLUMN IF EXISTS daily_obs;
