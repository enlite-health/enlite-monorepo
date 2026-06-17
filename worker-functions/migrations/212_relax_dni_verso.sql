-- Migration 212: Relaxar requisito do DNI verso (identity_document_back_url).
--
-- Decisão de produto (2026-06-17): o verso do DNI deixa de ser OBRIGATÓRIO
-- para o worker virar REGISTERED — passa a ser OPCIONAL (pode ser enviado,
-- mas não bloqueia o gate de elegibilidade).
--
-- O que NÃO muda:
--   Todos:  identity_document_url + criminal_record_url
--   AT:     também resume_cv_url + at_certificate_url
--
-- INVARIANTE: esta migration atualiza SIMULTANEAMENTE as 3 cópias da regra:
--   1. fn_guard_registered_status   (trigger de UPDATE em workers)
--   2. fn_worker_missing_fields     (SSOT de campos faltantes para postulação)
--   3. WorkerImportRepository.recalculateStatus  (query inline — ver arquivo TS)
--
-- A terceira cópia (recalculateStatus) é atualizada no commit TypeScript
-- correspondente. Esta migration lida com as duas funções PL/pgSQL.

-- ─── 1. fn_guard_registered_status ──────────────────────────────────────────
-- Copia integral da migration 208, removendo apenas:
--   AND wd.identity_document_back_url IS NOT NULL
-- do EXISTS de documentos.

CREATE OR REPLACE FUNCTION public.fn_guard_registered_status()
  RETURNS trigger
  LANGUAGE plpgsql
AS $function$
BEGIN
  -- Only blocks transitions TO 'REGISTERED'; DISABLED and INCOMPLETE_REGISTER pass freely
  IF NEW.status <> 'REGISTERED' THEN
    RETURN NEW;
  END IF;

  -- Merged workers must not be registered
  IF NEW.merged_into_id IS NOT NULL THEN
    RAISE EXCEPTION 'Worker mesclado (merged_into_id IS NOT NULL) não pode ser REGISTERED';
  END IF;

  -- Verify required personal fields in the workers table
  IF NOT (
    NEW.first_name_encrypted  IS NOT NULL AND NEW.first_name_encrypted  <> '' AND
    NEW.last_name_encrypted   IS NOT NULL AND NEW.last_name_encrypted   <> '' AND
    NEW.sex_encrypted         IS NOT NULL AND NEW.sex_encrypted         <> '' AND
    NEW.gender_encrypted      IS NOT NULL AND NEW.gender_encrypted      <> '' AND
    NEW.birth_date_encrypted  IS NOT NULL AND NEW.birth_date_encrypted  <> '' AND
    NEW.document_number_encrypted IS NOT NULL AND NEW.document_number_encrypted <> '' AND
    NEW.languages_encrypted   IS NOT NULL AND NEW.languages_encrypted   <> '' AND
    NEW.phone                 IS NOT NULL AND NEW.phone                 <> '' AND
    NEW.profession            IS NOT NULL AND NEW.profession            <> '' AND
    NEW.knowledge_level       IS NOT NULL AND NEW.knowledge_level       <> '' AND
    NEW.title_certificate     IS NOT NULL AND NEW.title_certificate     <> '' AND
    NEW.years_experience      IS NOT NULL AND NEW.years_experience      <> '' AND
    NEW.experience_types      IS NOT NULL AND array_length(NEW.experience_types, 1)    > 0 AND
    NEW.preferred_types       IS NOT NULL AND array_length(NEW.preferred_types, 1)      > 0 AND
    NEW.preferred_age_range   IS NOT NULL AND array_length(NEW.preferred_age_range, 1)  > 0
  ) THEN
    RAISE EXCEPTION 'Campos obrigatórios incompletos — não é possível marcar como REGISTERED';
  END IF;

  -- Verify satellite tables: service_area, availability, documents
  IF NOT EXISTS (
    SELECT 1 FROM worker_service_areas sa
    WHERE sa.worker_id = NEW.id AND sa.address_line IS NOT NULL AND sa.radius_km IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Endereço de atendimento não cadastrado — não é possível marcar como REGISTERED';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM worker_availability av
    WHERE av.worker_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'Disponibilidade não cadastrada — não é possível marcar como REGISTERED';
  END IF;

  -- Document gate (migration 212 — verso agora OPCIONAL):
  --   Todos:  identity_document_url + criminal_record_url
  --   AT:     também resume_cv_url + at_certificate_url
  --   identity_document_back_url: OPCIONAL para todos (removido do gate em 212)
  IF NOT EXISTS (
    SELECT 1 FROM worker_documents wd
    WHERE wd.worker_id = NEW.id
      AND wd.identity_document_url IS NOT NULL
      AND wd.criminal_record_url   IS NOT NULL
      AND (
        NEW.profession != 'AT'
        OR (wd.resume_cv_url IS NOT NULL AND wd.at_certificate_url IS NOT NULL)
      )
  ) THEN
    RAISE EXCEPTION 'Documentos obrigatórios incompletos — não é possível marcar como REGISTERED';
  END IF;

  RETURN NEW;
END;
$function$;

-- ─── 2. fn_worker_missing_fields ─────────────────────────────────────────────
-- Copia integral da migration 209, removendo apenas:
--   AND wd.identity_document_back_url IS NOT NULL
-- do EXISTS de documentos (migration 212 — verso agora OPCIONAL).

CREATE OR REPLACE FUNCTION public.fn_worker_missing_fields(p_worker_id UUID)
  RETURNS JSONB
  LANGUAGE plpgsql
  STABLE
AS $func$
DECLARE
  v_worker RECORD;
  v_missing TEXT[] := ARRAY[]::TEXT[];
BEGIN
  -- Busca linha do worker (excluindo mesclados)
  SELECT
    first_name_encrypted,
    last_name_encrypted,
    sex_encrypted,
    gender_encrypted,
    birth_date_encrypted,
    document_number_encrypted,
    languages_encrypted,
    phone,
    profession,
    knowledge_level,
    title_certificate,
    years_experience,
    experience_types,
    preferred_types,
    preferred_age_range,
    merged_into_id
  INTO v_worker
  FROM workers
  WHERE id = p_worker_id;

  -- Worker não existe
  IF NOT FOUND OR v_worker.merged_into_id IS NOT NULL THEN
    RETURN '["worker_not_found"]'::JSONB;
  END IF;

  -- ── Campos pessoais (espelha fn_guard_registered_status) ──────────────────
  IF v_worker.first_name_encrypted  IS NULL OR v_worker.first_name_encrypted  = '' THEN
    v_missing := array_append(v_missing, 'first_name');
  END IF;
  IF v_worker.last_name_encrypted   IS NULL OR v_worker.last_name_encrypted   = '' THEN
    v_missing := array_append(v_missing, 'last_name');
  END IF;
  IF v_worker.sex_encrypted         IS NULL OR v_worker.sex_encrypted         = '' THEN
    v_missing := array_append(v_missing, 'sex');
  END IF;
  IF v_worker.gender_encrypted      IS NULL OR v_worker.gender_encrypted      = '' THEN
    v_missing := array_append(v_missing, 'gender');
  END IF;
  IF v_worker.birth_date_encrypted  IS NULL OR v_worker.birth_date_encrypted  = '' THEN
    v_missing := array_append(v_missing, 'birth_date');
  END IF;
  IF v_worker.document_number_encrypted IS NULL OR v_worker.document_number_encrypted = '' THEN
    v_missing := array_append(v_missing, 'document_number');
  END IF;
  IF v_worker.languages_encrypted   IS NULL OR v_worker.languages_encrypted   = '' THEN
    v_missing := array_append(v_missing, 'languages');
  END IF;
  IF v_worker.phone IS NULL OR v_worker.phone = '' THEN
    v_missing := array_append(v_missing, 'phone');
  END IF;
  IF v_worker.profession IS NULL OR v_worker.profession = '' THEN
    v_missing := array_append(v_missing, 'profession');
  END IF;
  IF v_worker.knowledge_level IS NULL OR v_worker.knowledge_level = '' THEN
    v_missing := array_append(v_missing, 'knowledge_level');
  END IF;
  IF v_worker.title_certificate IS NULL OR v_worker.title_certificate = '' THEN
    v_missing := array_append(v_missing, 'title_certificate');
  END IF;
  IF v_worker.years_experience IS NULL OR v_worker.years_experience = '' THEN
    v_missing := array_append(v_missing, 'years_experience');
  END IF;
  IF v_worker.experience_types IS NULL OR array_length(v_worker.experience_types, 1) IS NULL OR
     array_length(v_worker.experience_types, 1) = 0 THEN
    v_missing := array_append(v_missing, 'experience_types');
  END IF;
  IF v_worker.preferred_types IS NULL OR array_length(v_worker.preferred_types, 1) IS NULL OR
     array_length(v_worker.preferred_types, 1) = 0 THEN
    v_missing := array_append(v_missing, 'preferred_types');
  END IF;
  IF v_worker.preferred_age_range IS NULL OR array_length(v_worker.preferred_age_range, 1) IS NULL OR
     array_length(v_worker.preferred_age_range, 1) = 0 THEN
    v_missing := array_append(v_missing, 'preferred_age_range');
  END IF;

  -- ── Área de atendimento (espelha fn_guard_registered_status) ──────────────
  IF NOT EXISTS (
    SELECT 1 FROM worker_service_areas sa
    WHERE sa.worker_id = p_worker_id
      AND sa.address_line IS NOT NULL
      AND sa.radius_km    IS NOT NULL
  ) THEN
    v_missing := array_append(v_missing, 'worker_service_areas');
  END IF;

  -- ── Disponibilidade (espelha fn_guard_registered_status) ──────────────────
  IF NOT EXISTS (
    SELECT 1 FROM worker_availability av
    WHERE av.worker_id = p_worker_id
  ) THEN
    v_missing := array_append(v_missing, 'worker_availability');
  END IF;

  -- ── Documentos (migration 212 — verso OPCIONAL) ───────────────────────────
  --   Todos:  identity_document_url + criminal_record_url
  --   AT:     também resume_cv_url + at_certificate_url
  --   identity_document_back_url: não exigido (OPCIONAL)
  IF NOT EXISTS (
    SELECT 1 FROM worker_documents wd
    WHERE wd.worker_id = p_worker_id
      AND wd.identity_document_url IS NOT NULL
      AND wd.criminal_record_url   IS NOT NULL
      AND (
        v_worker.profession != 'AT'
        OR (wd.resume_cv_url IS NOT NULL AND wd.at_certificate_url IS NOT NULL)
      )
  ) THEN
    v_missing := array_append(v_missing, 'worker_documents');
  END IF;

  RETURN to_jsonb(v_missing);
END;
$func$;

COMMENT ON FUNCTION public.fn_worker_missing_fields(UUID) IS
  'Retorna array JSONB com campos/tabelas faltantes para elegibilidade de postulação. '
  'SSOT de completude: espelha fn_guard_registered_status. '
  'INVARIANTE: atualizar esta função junto a fn_guard_registered_status em toda '
  'migration que altere os requisitos de REGISTERED. '
  'Migration 212: identity_document_back_url passou a OPCIONAL.';
