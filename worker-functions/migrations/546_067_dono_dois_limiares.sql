-- Migration 546: o dono da completude com DOIS limiares (spec 067, F1).
--
-- Regra de negócio: só quem está COMPLETO e com os documentos obrigatórios VALIDADOS chega a Completado/encuadre.
-- "Completo" (cadastro) e "apto" (completo + documentos validados) são dois limiares do MESMO dono:
--   * fn_worker_missing_fields_of(workers, strict)   núcleo; recebe a LINHA (não o id) — o guard roda BEFORE UPDATE
--                                                    e um SELECT por id dentro do trigger veria a linha ANTIGA (plan SUP-1);
--   * fn_worker_missing_fields(uuid)                 modo PADRÃO: saída byte a byte igual à da migration 212;
--   * fn_worker_missing_fields(uuid, boolean)        modo ESTRITO (sem DEFAULT: com DEFAULT a chamada de 1 argumento fica ambígua);
--   * fn_worker_is_apto(uuid)                        REGISTERED + estrito = '[]'. Não grava nada;
--   * fn_guard_registered_status()                   passa a decidir pelo núcleo em modo padrão (nenhuma regra própria).
--
-- Modo estrito acrescenta, depois de 'worker_documents', um token 'unvalidated_<slug>' para cada documento obrigatório da
-- profissão que TEM URL e NÃO tem a chave em worker_documents.document_validations (migration 132).
-- Slugs e colunas = workerDocumentPolicy.ts (identity_document, criminal_record; AT: + resume_cv, at_certificate).
-- Profissão: mesma expressão `profession != 'AT'` de hoje (NULL exige o conjunto AT, como hoje).

-- ─── 1. núcleo ──────────────────────────────────────────────────────────────
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

COMMENT ON FUNCTION public.fn_worker_missing_fields_of(public.workers, boolean) IS
  'Núcleo da completude (spec 067). Recebe a LINHA de workers (serve ao trigger BEFORE UPDATE). '
  'p_strict=false: cadastro completo (= fn_worker_missing_fields da 212). '
  'p_strict=true: acrescenta unvalidated_<slug> para documento obrigatório com URL e sem chave em document_validations.';

-- ─── 2. modo padrão (assinatura e saída da 212) ─────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_worker_missing_fields(p_worker_id UUID)
  RETURNS JSONB
  LANGUAGE plpgsql
  STABLE
AS $func$
DECLARE
  v_w public.workers;
BEGIN
  SELECT * INTO v_w FROM workers WHERE id = p_worker_id;
  IF NOT FOUND THEN
    RETURN '["worker_not_found"]'::JSONB;
  END IF;
  RETURN public.fn_worker_missing_fields_of(v_w, false);
END;
$func$;

COMMENT ON FUNCTION public.fn_worker_missing_fields(UUID) IS
  'Retorna array JSONB com campos/tabelas faltantes para elegibilidade de postulação (modo padrão). '
  'SSOT de completude: corpo em fn_worker_missing_fields_of (migration 546, spec 067). '
  'Migration 212: identity_document_back_url é OPCIONAL.';

-- ─── 3. modo estrito (SEM DEFAULT) ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_worker_missing_fields(p_worker_id UUID, p_strict BOOLEAN)
  RETURNS JSONB
  LANGUAGE plpgsql
  STABLE
AS $func$
DECLARE
  v_w public.workers;
BEGIN
  SELECT * INTO v_w FROM workers WHERE id = p_worker_id;
  IF NOT FOUND THEN
    RETURN '["worker_not_found"]'::JSONB;
  END IF;
  RETURN public.fn_worker_missing_fields_of(v_w, p_strict);
END;
$func$;

COMMENT ON FUNCTION public.fn_worker_missing_fields(UUID, BOOLEAN) IS
  'Mesmo que fn_worker_missing_fields(uuid); p_strict=true acrescenta unvalidated_<slug> (spec 067). Sem DEFAULT de propósito.';

-- ─── 4. apto ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_worker_is_apto(p_worker_id UUID)
  RETURNS BOOLEAN
  LANGUAGE plpgsql
  STABLE
AS $func$
DECLARE
  v_w public.workers;
BEGIN
  SELECT * INTO v_w FROM workers WHERE id = p_worker_id;
  IF NOT FOUND OR v_w.merged_into_id IS NOT NULL OR v_w.status <> 'REGISTERED' THEN
    RETURN false;
  END IF;
  RETURN public.fn_worker_missing_fields_of(v_w, true) = '[]'::JSONB;
END;
$func$;

COMMENT ON FUNCTION public.fn_worker_is_apto(UUID) IS
  'Apto = REGISTERED + cadastro completo + documentos obrigatórios VALIDADOS (spec 067). Não grava nada. '
  'É a expressão SQL única do "apto": Kanban, encuadre e contagens chamam esta função.';

-- ─── 5. guard: nenhuma regra própria, decide pelo dono ──────────────────────
CREATE OR REPLACE FUNCTION public.fn_guard_registered_status()
  RETURNS trigger
  LANGUAGE plpgsql
AS $function$
DECLARE
  v_missing JSONB;
BEGIN
  -- Only blocks transitions TO 'REGISTERED'; DISABLED and INCOMPLETE_REGISTER pass freely
  IF NEW.status <> 'REGISTERED' THEN
    RETURN NEW;
  END IF;

  -- Merged workers must not be registered
  IF NEW.merged_into_id IS NOT NULL THEN
    RAISE EXCEPTION 'Worker mesclado (merged_into_id IS NOT NULL) não pode ser REGISTERED';
  END IF;

  -- Decide pelo dono (modo padrão), lendo a LINHA nova: um SELECT por id aqui veria a linha ANTIGA.
  v_missing := public.fn_worker_missing_fields_of(NEW, false);
  IF v_missing <> '[]'::JSONB THEN
    RAISE EXCEPTION 'Cadastro incompleto — não é possível marcar como REGISTERED: %', v_missing;
  END IF;

  RETURN NEW;
END;
$function$;
