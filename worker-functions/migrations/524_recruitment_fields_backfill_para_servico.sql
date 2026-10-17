-- 524 — Spec 057 / D523: os 5 campos de recrutamento (sexo, profesiones, experiencia, jornada, dia de pago) passam a ter UM dono:
--   patient_contracted_services. A vaga (job_postings) deixa de ser dona e LE do serviço.
--
--   Em prd (medido em 16/10) o dado existe só na cópia da vaga: copia de volta ANTES de qualquer leitor ler do serviço.
--   Idempotente (COALESCE, só preenche NULL); aborta se um serviço tem 2+ vagas vivas com valores diferentes (decisão humana).
--   Não toca job_postings. Amplia o CHECK de field dos avisos com os 5 campos (avisos de mudança de fonte).
--   Rollback: migrations/pending/ROLLBACK_524_recruitment_fields_backfill_para_servico.sql
--
-- 057 / D523: os 5 campos de recrutamento passam a ter UM dono (patient_contracted_services). Em prd (16/10) o dado
-- existe só na cópia da vaga: copiar de volta ANTES de qualquer leitor ler do serviço. Idempotente. Não toca job_postings.
DO $m524$
DECLARE v_conf int; v_n_sex int; v_n_prof int; v_n_exp int; v_n_ws int; v_n_pd int;
BEGIN
  PERFORM set_config('lock_timeout', '10s', true);
  -- guarda: serviço com 2+ vagas vivas e valores NÃO NULOS diferentes no mesmo campo → abortar (decisão humana)
  SELECT count(*) INTO v_conf FROM (
    SELECT jp.contracted_service_id
    FROM job_postings jp WHERE jp.deleted_at IS NULL AND jp.contracted_service_id IS NOT NULL
    GROUP BY jp.contracted_service_id
    HAVING count(DISTINCT jp.required_sex) FILTER (WHERE jp.required_sex IS NOT NULL) > 1
        OR count(DISTINCT jp.required_professions) FILTER (WHERE cardinality(jp.required_professions) > 0) > 1
        OR count(DISTINCT jp.required_experience) FILTER (WHERE jp.required_experience IS NOT NULL) > 1
        OR count(DISTINCT jp.work_schedule) FILTER (WHERE jp.work_schedule IS NOT NULL) > 1
        OR count(DISTINCT jp.payment_day) FILTER (WHERE jp.payment_day IS NOT NULL) > 1) c;
  IF v_conf > 0 THEN RAISE EXCEPTION '057/524: % serviço(s) com vagas vivas divergentes entre si; resolver à mão antes', v_conf; END IF;

  WITH src AS (
    SELECT DISTINCT ON (jp.contracted_service_id) jp.contracted_service_id AS sid,
           jp.required_sex, NULLIF(jp.required_professions, '{}'::text[]) AS required_professions,
           jp.required_experience, jp.work_schedule, jp.payment_day
    FROM job_postings jp WHERE jp.deleted_at IS NULL AND jp.contracted_service_id IS NOT NULL
    ORDER BY jp.contracted_service_id, jp.updated_at DESC)
  UPDATE patient_contracted_services pcs SET
    required_sex         = COALESCE(pcs.required_sex, src.required_sex),
    required_professions = COALESCE(pcs.required_professions, src.required_professions),
    required_experience  = COALESCE(pcs.required_experience, src.required_experience),
    work_schedule        = COALESCE(pcs.work_schedule, src.work_schedule),
    payment_day          = COALESCE(pcs.payment_day, src.payment_day)
  FROM src WHERE pcs.id = src.sid
    AND (pcs.required_sex IS NULL AND src.required_sex IS NOT NULL
      OR pcs.required_professions IS NULL AND src.required_professions IS NOT NULL
      OR pcs.required_experience IS NULL AND src.required_experience IS NOT NULL
      OR pcs.work_schedule IS NULL AND src.work_schedule IS NOT NULL
      OR pcs.payment_day IS NULL AND src.payment_day IS NOT NULL);
  GET DIAGNOSTICS v_n_sex = ROW_COUNT;
  RAISE NOTICE '057/524: % serviços atualizados', v_n_sex;
END $m524$;

ALTER TABLE vacancy_source_change_notices DROP CONSTRAINT IF EXISTS vscn_field_check;
ALTER TABLE vacancy_source_change_notices ADD CONSTRAINT vscn_field_check CHECK (field IN
  ('schedule','providers_needed','age_range','required_sex','required_professions','required_experience','work_schedule','payment_day'));
COMMENT ON COLUMN patient_contracted_services.required_sex IS 'Sexo requerido del prestador: M | F | BOTH (validado en Zod, sin CHECK). Requisito de seguridad del paciente (D507): filtro duro del matching. El motivo NUNCA se registra. NULL = sin responder; BOTH = indistinto. UNICO dueño: la vacante LEE de aca (057/D523).';
COMMENT ON COLUMN patient_contracted_services.required_professions IS 'Profesiones buscadas para la vacante (catalogo). La vacante LEE de aca (057/D523). NULL = sin informar.';
COMMENT ON COLUMN patient_contracted_services.required_experience IS 'Experiencia requerida del prestador (texto libre, tope en Zod). No incluir informacion de salud del paciente. La vacante LEE de aca (057/D523).';
COMMENT ON COLUMN patient_contracted_services.work_schedule IS 'Tipo de jornada: full-time | part-time | flexible (validado en Zod). La vacante LEE de aca (057/D523).';
COMMENT ON COLUMN patient_contracted_services.payment_day IS 'Día de pago al prestador (el día en que Enlite le paga al prestador; NO es el plazo de pago de la familia/obra social). La vacante LEE de aca (057/D523).';
