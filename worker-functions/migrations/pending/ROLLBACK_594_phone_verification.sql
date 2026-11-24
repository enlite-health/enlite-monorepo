-- ROLLBACK_594_phone_verification.sql — par de rollback da migration 594 (PR-INF-47). Só documentação; NÃO é aplicado pelo runner.
-- Ordem: o dono da completude volta ao da 546 (sem phone_unverified) ANTES de apagar a função e as colunas que ele lê.

CREATE OR REPLACE FUNCTION public.fn_worker_missing_fields_of(p_w public.workers, p_strict boolean)
  RETURNS JSONB
  LANGUAGE plpgsql
  STABLE
AS $func$
DECLARE
  v_missing TEXT[] := ARRAY[]::TEXT[];
BEGIN
  -- Worker não existe / mesclado
  IF p_w.id IS NULL OR p_w.merged_into_id IS NOT NULL THEN
    RETURN '["worker_not_found"]'::JSONB;
  END IF;

  -- ── Campos pessoais (espelha fn_guard_registered_status) ──────────────────
  IF p_w.first_name_encrypted  IS NULL OR p_w.first_name_encrypted  = '' THEN
    v_missing := array_append(v_missing, 'first_name');
  END IF;
  IF p_w.last_name_encrypted   IS NULL OR p_w.last_name_encrypted   = '' THEN
    v_missing := array_append(v_missing, 'last_name');
  END IF;
  IF p_w.sex_encrypted         IS NULL OR p_w.sex_encrypted         = '' THEN
    v_missing := array_append(v_missing, 'sex');
  END IF;
  IF p_w.gender_encrypted      IS NULL OR p_w.gender_encrypted      = '' THEN
    v_missing := array_append(v_missing, 'gender');
  END IF;
  IF p_w.birth_date_encrypted  IS NULL OR p_w.birth_date_encrypted  = '' THEN
    v_missing := array_append(v_missing, 'birth_date');
  END IF;
  IF p_w.document_number_encrypted IS NULL OR p_w.document_number_encrypted = '' THEN
    v_missing := array_append(v_missing, 'document_number');
  END IF;
  IF p_w.languages_encrypted   IS NULL OR p_w.languages_encrypted   = '' THEN
    v_missing := array_append(v_missing, 'languages');
  END IF;
  IF p_w.phone IS NULL OR p_w.phone = '' THEN
    v_missing := array_append(v_missing, 'phone');
  END IF;
  IF p_w.profession IS NULL OR p_w.profession = '' THEN
    v_missing := array_append(v_missing, 'profession');
  END IF;
  IF p_w.knowledge_level IS NULL OR p_w.knowledge_level = '' THEN
    v_missing := array_append(v_missing, 'knowledge_level');
  END IF;
  IF p_w.title_certificate IS NULL OR p_w.title_certificate = '' THEN
    v_missing := array_append(v_missing, 'title_certificate');
  END IF;
  IF p_w.years_experience IS NULL OR p_w.years_experience = '' THEN
    v_missing := array_append(v_missing, 'years_experience');
  END IF;
  IF p_w.experience_types IS NULL OR array_length(p_w.experience_types, 1) IS NULL OR
     array_length(p_w.experience_types, 1) = 0 THEN
    v_missing := array_append(v_missing, 'experience_types');
  END IF;
  IF p_w.preferred_types IS NULL OR array_length(p_w.preferred_types, 1) IS NULL OR
     array_length(p_w.preferred_types, 1) = 0 THEN
    v_missing := array_append(v_missing, 'preferred_types');
  END IF;
  IF p_w.preferred_age_range IS NULL OR array_length(p_w.preferred_age_range, 1) IS NULL OR
     array_length(p_w.preferred_age_range, 1) = 0 THEN
    v_missing := array_append(v_missing, 'preferred_age_range');
  END IF;

  -- ── Área de atendimento (espelha fn_guard_registered_status) ──────────────
  IF NOT EXISTS (
    SELECT 1 FROM worker_service_areas sa
    WHERE sa.worker_id = p_w.id
      AND sa.address_line IS NOT NULL
      AND sa.radius_km    IS NOT NULL
  ) THEN
    v_missing := array_append(v_missing, 'worker_service_areas');
  END IF;

  -- ── Disponibilidade (espelha fn_guard_registered_status) ──────────────────
  IF NOT EXISTS (
    SELECT 1 FROM worker_availability av
    WHERE av.worker_id = p_w.id
  ) THEN
    v_missing := array_append(v_missing, 'worker_availability');
  END IF;

  -- ── Documentos (migration 212 — verso OPCIONAL) ───────────────────────────
  --   Todos:  identity_document_url + criminal_record_url
  --   AT:     também resume_cv_url + at_certificate_url
  IF NOT EXISTS (
    SELECT 1 FROM worker_documents wd
    WHERE wd.worker_id = p_w.id
      AND wd.identity_document_url IS NOT NULL
      AND wd.criminal_record_url   IS NOT NULL
      AND (
        p_w.profession != 'AT'
        OR (wd.resume_cv_url IS NOT NULL AND wd.at_certificate_url IS NOT NULL)
      )
  ) THEN
    v_missing := array_append(v_missing, 'worker_documents');
  END IF;

  -- ── Modo estrito: documento obrigatório com URL e SEM validação ───────────
  IF p_strict THEN
    IF EXISTS (SELECT 1 FROM worker_documents wd
               WHERE wd.worker_id = p_w.id AND wd.identity_document_url IS NOT NULL
                 AND NOT jsonb_exists(wd.document_validations, 'identity_document')) THEN
      v_missing := array_append(v_missing, 'unvalidated_identity_document');
    END IF;
    IF EXISTS (SELECT 1 FROM worker_documents wd
               WHERE wd.worker_id = p_w.id AND wd.criminal_record_url IS NOT NULL
                 AND NOT jsonb_exists(wd.document_validations, 'criminal_record')) THEN
      v_missing := array_append(v_missing, 'unvalidated_criminal_record');
    END IF;
    IF p_w.profession IS NULL OR p_w.profession = 'AT' THEN
      IF EXISTS (SELECT 1 FROM worker_documents wd
                 WHERE wd.worker_id = p_w.id AND wd.resume_cv_url IS NOT NULL
                   AND NOT jsonb_exists(wd.document_validations, 'resume_cv')) THEN
        v_missing := array_append(v_missing, 'unvalidated_resume_cv');
      END IF;
      IF EXISTS (SELECT 1 FROM worker_documents wd
                 WHERE wd.worker_id = p_w.id AND wd.at_certificate_url IS NOT NULL
                   AND NOT jsonb_exists(wd.document_validations, 'at_certificate')) THEN
        v_missing := array_append(v_missing, 'unvalidated_at_certificate');
      END IF;
    END IF;
  END IF;

  RETURN to_jsonb(v_missing);
END;
$func$;

DROP TRIGGER IF EXISTS trg_guard_phone_verification_waiver ON workers;
DROP FUNCTION IF EXISTS public.fn_guard_phone_verification_waiver();
DROP FUNCTION IF EXISTS public.fn_worker_phone_verification_state(UUID);
DROP FUNCTION IF EXISTS public.fn_worker_phone_is_verified(public.workers);
DROP INDEX IF EXISTS uq_workers_phone_verified_now;
DROP INDEX IF EXISTS uq_workers_phone_verified_otp_challenge;
ALTER TABLE workers
  DROP CONSTRAINT IF EXISTS workers_phone_verified_all_or_nothing,
  DROP CONSTRAINT IF EXISTS workers_phone_verified_method_check,
  DROP COLUMN IF EXISTS phone_verified_normalized,
  DROP COLUMN IF EXISTS phone_verified_at,
  DROP COLUMN IF EXISTS phone_verified_method,
  DROP COLUMN IF EXISTS phone_verified_otp_challenge_id,
  DROP COLUMN IF EXISTS phone_verification_waived_at;
