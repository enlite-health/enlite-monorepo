-- ROLLBACK_524_recruitment_fields_backfill_para_servico.sql — par de rollback da migration 524
-- (spec 057 / D523: os 5 campos de recrutamento passam a ter UM dono, patient_contracted_services).
--
-- QUANDO USAR: regressão detectada depois do deploy da 524 em prd. Mora em migrations/pending/ porque o runner
-- (scripts/run-migrations-docker.js) ignora essa pasta: só roda com caminho explícito.
--   ./scripts/run-migration-prod.sh worker-functions/migrations/pending/ROLLBACK_524_recruitment_fields_backfill_para_servico.sql
--
-- Desfaz: (1) avisos dos 5 campos novos; (2) CHECK volta a 3 campos; (3) limpa os 5 campos nos 20 serviços que a 524
-- preencheu em prd em 16/10 (ids medidos na réplica depois da 524); (4) restaura os COMMENTs anteriores.
-- LIMITAÇÃO CONHECIDA: valor preenchido À MÃO nesses 20 serviços depois da 524 também é apagado.
-- A cópia na vaga (job_postings) nunca foi tocada pela 524, então nada a restaurar lá.
BEGIN;

DELETE FROM vacancy_source_change_notices
 WHERE field IN ('required_sex','required_professions','required_experience','work_schedule','payment_day');

ALTER TABLE vacancy_source_change_notices DROP CONSTRAINT IF EXISTS vscn_field_check;
ALTER TABLE vacancy_source_change_notices ADD CONSTRAINT vscn_field_check CHECK (field IN
  ('schedule','providers_needed','age_range'));

UPDATE patient_contracted_services
   SET required_sex = NULL, required_professions = NULL, required_experience = NULL,
       work_schedule = NULL, payment_day = NULL
 WHERE id IN (
    '09d8be44-7102-4148-a338-27bb67cccfb9',
    '0e785402-40c4-43d4-bc12-c9f9d83b3545',
    '30540b65-533a-4c56-b559-1a1cb5255d96',
    '3607a7bb-b2d4-4e61-adf3-071d46230338',
    '365aa6d8-6504-405c-a85e-3678a9b9df64',
    '3c7ad58d-580e-4aff-ba4e-8eb2473415b8',
    '4927cc58-b772-4a67-9df8-c04cde1393f6',
    '5be489cc-c1ad-4626-9785-6a536d4dc5a2',
    '65c9f27e-2810-4526-88a0-de70aef529a4',
    '78441360-414a-417b-8e6f-f122d813aad3',
    '8545b4ce-5841-452c-8494-532ab05474ac',
    '9261ce28-36d8-41b3-8f28-7cc1f7c7a499',
    'a5fe07e9-75cd-490f-932a-0b72367ae0e1',
    'c341581e-ceec-460f-8603-344bfaf290ac',
    'd72056f1-8718-4cec-9630-864937774178',
    'e583b612-6651-4934-a6b8-4bf6c8402570',
    'eac48c03-31b0-4e0e-b960-18b4800648e1',
    'f6923a75-675f-4d76-a77e-60c771be747a',
    'f804a321-b292-4a1f-bd05-5187987163c2',
    'fdf7c68e-c52f-4d26-a095-1599fb8a92c6'
  );

COMMENT ON COLUMN patient_contracted_services.payment_day IS 'Día de pago al prestador (el día en que Enlite le paga al prestador; NO es el plazo de pago de la familia/obra social). Se copia a la vacante (D508).';
COMMENT ON COLUMN patient_contracted_services.required_experience IS 'Experiencia requerida del prestador (texto libre, tope en Zod). No incluir informacion de salud del paciente. Se copia a la vacante (D508).';
COMMENT ON COLUMN patient_contracted_services.required_professions IS 'Profesiones buscadas para la vacante (catalogo). Se copia a la vacante al activar reclutamiento (D508). NULL = sin informar.';
COMMENT ON COLUMN patient_contracted_services.required_sex IS 'Sexo requerido del prestador: M | F | BOTH (validado en Zod, sin CHECK). Requisito de seguridad del paciente (D507): filtro duro del matching. El motivo NUNCA se registra. NULL = sin responder; BOTH = indistinto.';
COMMENT ON COLUMN patient_contracted_services.work_schedule IS 'Tipo de jornada: full-time | part-time | flexible (validado en Zod). Se copia a la vacante (D508).';

COMMIT;
