-- Migration 208: Update fn_guard_registered_status to reflect new document requirements.
--
-- Old gate (removed): professional_registration_url, liability_insurance_url required for all.
-- New gate:
--   All workers: identity_document_url + identity_document_back_url + criminal_record_url
--   AT workers additionally: resume_cv_url + at_certificate_url

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

  -- Document gate (new policy from migration 207):
  --   All professions: DNI frente + DNI verso + antecedentes
  --   AT additionally: CV + cert AT
  IF NOT EXISTS (
    SELECT 1 FROM worker_documents wd
    WHERE wd.worker_id = NEW.id
      AND wd.identity_document_url      IS NOT NULL
      AND wd.identity_document_back_url IS NOT NULL
      AND wd.criminal_record_url        IS NOT NULL
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
