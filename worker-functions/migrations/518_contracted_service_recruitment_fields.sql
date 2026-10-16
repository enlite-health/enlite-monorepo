-- 518 — Spec 027 Fase 3 (US3): o serviço contratado guarda o que a vaga precisa (D507, D508).
--
-- Sete colunas novas em `patient_contracted_services`, TODAS anuláveis e sem DEFAULT. Sem CHECK e sem NOT NULL de propósito:
-- a obrigatoriedade é do portão "ativar recrutamento" (PatientCompleteness), e o vocabulário é do Zod da borda
-- (contractedServiceSchemas.ts), não do banco.
--
-- O QUE `NULL` SIGNIFICA (uma coisa só por coluna; nenhuma linha antiga é preenchida, sem backfill):
--   required_professions  NULL = ainda não informado. `{}` (vazio) NÃO é gravado pela borda; o portão trata os dois como faltando.
--   required_sex          NULL = ainda não respondido (o portão trata como FALTANDO). 'BOTH' = respondido, indistinto.
--   required_experience   NULL = ainda não informado.
--   worker_attributes     NULL = vazio. SÓ FICHA: não é copiado para a vaga (D508 a).
--   work_schedule         NULL = ainda não informado (tipo de jornada: full-time | part-time | flexible, validado no Zod).
--   payment_day           NULL = ainda não informado.
--   daily_obs             NULL = vazio. SÓ FICHA: não é copiado para a vaga (D508 a).
--
-- Copiados para a vaga na ativação (ActivateRecruitmentUseCase): required_professions, required_sex, required_experience,
-- work_schedule, payment_day. Cópia LITERAL; nunca derivada de dado do paciente (lex S.5).
--
-- P.1 (lex): `payment_day` é o dia em que a Enlite paga o PRESTADOR, não o termo de pagamento da família/obra social
-- (D508 b). Está dito no COMMENT da coluna abaixo.
-- Quatro colunas são TEXTO LIVRE dentro da ficha do paciente (required_experience, worker_attributes, payment_day, daily_obs):
-- o parecer lex (T.2) pede que o conector de LLM (`enlite_mcp_ro`) não as leia; ver scripts/create-mcp-ro-role.sql (mesmo PR).
--
-- Aditiva e idempotente (2×): ADD COLUMN IF NOT EXISTS. Sem BEGIN/COMMIT próprio (o runner cuida disso).
-- VOLTA: pending/ROLLBACK_518_contracted_service_recruitment_fields.sql (perde só o que foi gravado nestas 7 colunas).

ALTER TABLE patient_contracted_services
  ADD COLUMN IF NOT EXISTS required_professions TEXT[]       NULL,
  ADD COLUMN IF NOT EXISTS required_sex          TEXT         NULL,
  ADD COLUMN IF NOT EXISTS required_experience   TEXT         NULL,
  ADD COLUMN IF NOT EXISTS worker_attributes     TEXT         NULL,
  ADD COLUMN IF NOT EXISTS work_schedule         VARCHAR(50)  NULL,
  ADD COLUMN IF NOT EXISTS payment_day           TEXT         NULL,
  ADD COLUMN IF NOT EXISTS daily_obs             TEXT         NULL;

COMMENT ON COLUMN patient_contracted_services.required_professions IS
  'Profesiones buscadas para la vacante (catalogo). Se copia a la vacante al activar reclutamiento (D508). NULL = sin informar.';
COMMENT ON COLUMN patient_contracted_services.required_sex IS
  'Sexo requerido del prestador: M | F | BOTH (validado en Zod, sin CHECK). Requisito de seguridad del paciente (D507): filtro duro del matching. El motivo NUNCA se registra. NULL = sin responder; BOTH = indistinto.';
COMMENT ON COLUMN patient_contracted_services.required_experience IS
  'Experiencia requerida del prestador (texto libre, tope en Zod). No incluir informacion de salud del paciente. Se copia a la vacante (D508).';
COMMENT ON COLUMN patient_contracted_services.worker_attributes IS
  'Atributos del prestador buscado (texto libre). Solo ficha, no se copia a la vacante (D508).';
COMMENT ON COLUMN patient_contracted_services.work_schedule IS
  'Tipo de jornada: full-time | part-time | flexible (validado en Zod). Se copia a la vacante (D508).';
COMMENT ON COLUMN patient_contracted_services.payment_day IS
  'Día de pago al prestador (el día en que Enlite le paga al prestador; NO es el plazo de pago de la familia/obra social). Se copia a la vacante (D508).';
COMMENT ON COLUMN patient_contracted_services.daily_obs IS
  'Observaciones operativas (texto libre). Solo ficha, no se copia a la vacante (D508). No incluir informacion de salud ni el motivo de los requisitos.';
