-- 525 — Spec 057 / D523 (PR 2, CONTRAIR): a vaga (job_postings) deixa de guardar a cópia dos 5 campos de recrutamento
--   (required_sex, required_professions, required_experience, work_schedule, payment_day). O dono é
--   patient_contracted_services; a vaga com serviço contratado LÊ de lá (código do PR 1, em prd desde 17/10).
--
--   Pré-condição: 524 aplicada + código do PR 1 em prd. A guarda abaixo aborta se alguma vaga viva ainda tem dado
--   só na cópia (serviço NULL no campo) — sinal de que a 524 não rodou/conferiu.
--   Faz: (1) guarda; (2) zera os 5 campos nas vagas com contracted_service_id; (3) amplia o CHECK da 511
--   (job_postings_service_owns_fields_chk) de 4 para 9 colunas. Vaga MANUAL (sem serviço) segue dona dos 9 campos.
--   Re-rodável: UPDATE só toca o que ainda tem valor; DROP IF EXISTS + ADD. Tudo em UM bloco DO (atômico).
--   LIMITAÇÃO: a guarda só olha vagas vivas (deleted_at IS NULL), mas o UPDATE zera também as soft-deleted; dado só na cópia de vaga apagada volta só pelo backup.
--   Rollback: migrations/pending/ROLLBACK_525_vaga_sem_copia_dos_campos_de_recrutamento.sql
DO $m525$
BEGIN
  PERFORM set_config('lock_timeout', '10s', true);
  -- pré-condição: os 5 do serviço estão preenchidos onde a vaga viva tinha valor (524 rodou)
  IF EXISTS (SELECT 1 FROM job_postings jp JOIN patient_contracted_services pcs ON pcs.id = jp.contracted_service_id
             WHERE jp.deleted_at IS NULL AND (
               (jp.required_sex IS NOT NULL AND pcs.required_sex IS NULL) OR
               (cardinality(jp.required_professions) > 0 AND (pcs.required_professions IS NULL OR cardinality(pcs.required_professions) = 0)) OR
               (jp.required_experience IS NOT NULL AND pcs.required_experience IS NULL) OR
               (jp.work_schedule IS NOT NULL AND pcs.work_schedule IS NULL) OR
               (jp.payment_day IS NOT NULL AND pcs.payment_day IS NULL)))
  THEN RAISE EXCEPTION '057/525: há vaga viva com dado só na cópia; rodar/conferir a 524 antes'; END IF;

  UPDATE job_postings SET required_sex=NULL, required_professions=NULL, required_experience=NULL, work_schedule=NULL, payment_day=NULL
  WHERE contracted_service_id IS NOT NULL
    AND (required_sex IS NOT NULL OR required_professions IS DISTINCT FROM NULL OR required_experience IS NOT NULL
         OR work_schedule IS NOT NULL OR payment_day IS NOT NULL);

  ALTER TABLE job_postings DROP CONSTRAINT IF EXISTS job_postings_service_owns_fields_chk;
  ALTER TABLE job_postings ADD CONSTRAINT job_postings_service_owns_fields_chk CHECK (
    contracted_service_id IS NULL OR (
      schedule IS NULL AND providers_needed IS NULL AND age_range_min IS NULL AND age_range_max IS NULL
      AND required_sex IS NULL AND (required_professions IS NULL OR required_professions = '{}'::text[])
      AND required_experience IS NULL AND work_schedule IS NULL AND payment_day IS NULL)) NOT VALID;
  ALTER TABLE job_postings VALIDATE CONSTRAINT job_postings_service_owns_fields_chk;
  COMMENT ON CONSTRAINT job_postings_service_owns_fields_chk ON job_postings IS
    '511 + 057 (D514/D522/D523): vaga com serviço contratado NÃO guarda horário, quantidade, faixa etária nem os 5 campos de recrutamento; lê tudo do serviço. Vaga manual segue dona dos 9 campos.';
END $m525$;
