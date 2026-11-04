-- ROLLBACK_525_vaga_sem_copia_dos_campos_de_recrutamento.sql — par de rollback da migration 525
-- (spec 057 / D523: a vaga com serviço contratado deixa de guardar a cópia dos 5 campos de recrutamento).
--
-- QUANDO USAR: regressão detectada depois do deploy da 525 em prd. Mora em migrations/pending/ porque o runner
-- (scripts/run-migrations-docker.js) ignora essa pasta: só roda com caminho explícito.
--   ./scripts/run-migration-prod.sh worker-functions/migrations/pending/ROLLBACK_525_vaga_sem_copia_dos_campos_de_recrutamento.sql
--
-- Desfaz: (1) dropa o CHECK de 9 colunas; (2) recopia pcs → jp os 5 campos em toda vaga com contracted_service_id;
-- (3) recria o CHECK da 511 (4 colunas) exatamente como era, NOT VALID + VALIDATE; (4) restaura o COMMENT.
-- LIMITAÇÃO: o valor da vaga que DIVERGIA do serviço antes da 525 só volta pelo backup; aqui volta o valor do serviço.
-- Para voltar ao código do PR 1 isto basta; a 524 (serviço preenchido) permanece.
BEGIN;
SELECT set_config('lock_timeout', '10s', true);

ALTER TABLE job_postings DROP CONSTRAINT IF EXISTS job_postings_service_owns_fields_chk;

UPDATE job_postings jp
   SET required_sex = pcs.required_sex,
       required_professions = pcs.required_professions,
       required_experience = pcs.required_experience,
       work_schedule = pcs.work_schedule,
       payment_day = pcs.payment_day
  FROM patient_contracted_services pcs
 WHERE pcs.id = jp.contracted_service_id
   AND jp.contracted_service_id IS NOT NULL;

ALTER TABLE job_postings ADD CONSTRAINT job_postings_service_owns_fields_chk
  CHECK (contracted_service_id IS NULL
         OR (schedule IS NULL AND providers_needed IS NULL AND age_range_min IS NULL AND age_range_max IS NULL))
  NOT VALID;
ALTER TABLE job_postings VALIDATE CONSTRAINT job_postings_service_owns_fields_chk;
COMMENT ON CONSTRAINT job_postings_service_owns_fields_chk ON job_postings IS
  'F7 (vaga-le-do-servico-contratado): vaga com serviço contratado NÃO guarda horário, quantidade nem faixa etária — o valor mora em patient_contracted_services. Vaga manual (contracted_service_id NULL) segue dona dos 4 campos.';

COMMIT;
