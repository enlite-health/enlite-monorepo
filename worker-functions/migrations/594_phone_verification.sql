-- Migration 594: celular verificado (spec 077, emenda de 22/11/2026, D776 a D779, PR-INF-47)
--
-- DONOS (D514): o FATO "última prova de posse do celular desta ficha" = as 4 colunas `workers.phone_verified_*`; o ESTADO
-- ("verificado agora?") é DERIVADO, nunca gravado: `fn_worker_phone_is_verified(workers)` decide, e
-- `fn_worker_phone_verification_state(uuid)` só a chama (D516). O dono da completude `fn_worker_missing_fields_of` (546) passa a
-- ler a MESMA função (item `phone_unverified`): o guard e o recálculo não ganham regra própria.
--
-- NULLs: `phone_verified_normalized/_at/_method` NULL juntos = "esta ficha nunca provou posse" (CHECK tudo-ou-nada, sem meio-estado).
-- `phone_verified_otp_challenge_id` NULL = prova pelo plano B (o código mora na Twilio) OU desafio já expurgado (ON DELETE SET NULL,
-- para a retenção de otp_challenges nunca ser travada por esta FK). `phone_verification_waived_at` NULL = "a exigência vale".
-- Vigência: trocar o número muda `phone_normalized` e a igualdade falha, SEM UPDATE nestas colunas; só uma prova nova as sobrescreve.
-- Duplicata: 1 ficha viva verificada por número (índice parcial) e 1 desafio prova no máximo 1 ficha (índice parcial).
--
-- DISPENSA POR LEGADO (§7.1): no corte, as REGISTERED vivas recebem `phone_verification_waived_at = now()` UMA vez (o histórico de
-- status não permite derivar "já era completa"). O gatilho recusa tirar ou trocar a marca; NULL -> valor só com
-- `SET LOCAL enlite.merge_in_progress = 'on'` (o merge, que a soma à sobrevivente; esta migration também o declara para carimbar).
-- Dispensa carimbada e contagem vão para o log da migration (RAISE NOTICE).
--
-- Roda como `enlite_app` (dono). Sem GRANT/REVOKE. Idempotente (2x). Sem BEGIN/COMMIT (o runner envolve).
-- Rollback: `migrations/pending/ROLLBACK_594_phone_verification.sql`.

ALTER TABLE workers
  ADD COLUMN IF NOT EXISTS phone_verified_normalized        TEXT,
  ADD COLUMN IF NOT EXISTS phone_verified_at                TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS phone_verified_method            TEXT,
  ADD COLUMN IF NOT EXISTS phone_verified_otp_challenge_id  UUID REFERENCES otp_challenges(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS phone_verification_waived_at     TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workers_phone_verified_all_or_nothing') THEN
    ALTER TABLE workers ADD CONSTRAINT workers_phone_verified_all_or_nothing
      CHECK (num_nulls(phone_verified_normalized, phone_verified_at, phone_verified_method) IN (0, 3));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workers_phone_verified_method_check') THEN
    ALTER TABLE workers ADD CONSTRAINT workers_phone_verified_method_check
      CHECK (phone_verified_method IN ('otp_whatsapp_template', 'otp_verify_whatsapp'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_workers_phone_verified_now
  ON workers (phone_verified_normalized)
  WHERE phone_verified_normalized IS NOT NULL AND phone_verified_normalized = phone_normalized AND merged_into_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_workers_phone_verified_otp_challenge
  ON workers (phone_verified_otp_challenge_id) WHERE phone_verified_otp_challenge_id IS NOT NULL;

COMMENT ON COLUMN workers.phone_verified_normalized IS 'Número provado por último (mesma normalização de phone_normalized). Fato congelado: diverge do telefone após uma troca, e é isso que mata a verificação.';
COMMENT ON COLUMN workers.phone_verification_waived_at IS 'Instante do corte em que a ficha, já REGISTERED viva, foi dispensada de celular verificado. NULL = a exigência vale. Gatilho impede tirar/trocar.';

-- ─── 1. "verificado" é DERIVADO: um dono só ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_worker_phone_is_verified(p_w public.workers)
  RETURNS boolean
  LANGUAGE sql
  STABLE
AS $func$
  SELECT p_w.phone_verified_normalized IS NOT NULL
     AND p_w.phone_verified_normalized = p_w.phone_normalized
     AND p_w.merged_into_id IS NULL;
$func$;

CREATE OR REPLACE FUNCTION public.fn_worker_phone_verification_state(p_worker_id UUID)
  RETURNS text
  LANGUAGE plpgsql
  STABLE
AS $func$
DECLARE
  v_w public.workers;
BEGIN
  SELECT * INTO v_w FROM public.workers WHERE id = p_worker_id;
  IF NOT FOUND OR v_w.phone IS NULL OR v_w.phone = '' THEN
    RETURN 'no_phone';
  END IF;
  IF public.fn_worker_phone_is_verified(v_w) THEN
    RETURN 'verified';
  END IF;
  RETURN 'unverified';
END;
$func$;

COMMENT ON FUNCTION public.fn_worker_phone_is_verified(public.workers) IS 'Único dono de "celular verificado agora" (emenda 077 §2.3/§7.2). Ninguém lê phone_verified_* para decidir por conta própria.';
COMMENT ON FUNCTION public.fn_worker_phone_verification_state(UUID) IS 'no_phone | verified | unverified; nunca NULL. Chama fn_worker_phone_is_verified.';

-- ─── 2. gatilho da marca de dispensa ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_guard_phone_verification_waiver()
  RETURNS trigger
  LANGUAGE plpgsql
AS $func$
BEGIN
  IF OLD.phone_verification_waived_at IS NOT NULL THEN
    RAISE EXCEPTION 'phone_verification_waived_at não pode ser removida nem trocada';
  END IF;
  -- OLD NULL -> NEW valor: só o merge (ou o carimbo da migration) declara.
  IF coalesce(current_setting('enlite.merge_in_progress', true), '') <> 'on' THEN
    RAISE EXCEPTION 'phone_verification_waived_at só é escrita pelo merge (enlite.merge_in_progress = on)';
  END IF;
  RETURN NEW;
END;
$func$;

DROP TRIGGER IF EXISTS trg_guard_phone_verification_waiver ON workers;
CREATE TRIGGER trg_guard_phone_verification_waiver
  BEFORE UPDATE OF phone_verification_waived_at ON workers
  FOR EACH ROW
  WHEN (OLD.phone_verification_waived_at IS DISTINCT FROM NEW.phone_verification_waived_at)
  EXECUTE FUNCTION public.fn_guard_phone_verification_waiver();

-- ─── 3. carimbo ÚNICO do corte (mesma transação que muda o dono da completude) ───────────────────────────────────
DO $$
DECLARE
  v_marcadas bigint;
  v_vivas    bigint;
BEGIN
  PERFORM set_config('enlite.merge_in_progress', 'on', true);
  UPDATE workers SET phone_verification_waived_at = now()
   WHERE status = 'REGISTERED' AND merged_into_id IS NULL AND phone_verification_waived_at IS NULL;
  GET DIAGNOSTICS v_marcadas = ROW_COUNT;
  PERFORM set_config('enlite.merge_in_progress', 'off', true);
  SELECT count(*) INTO v_vivas FROM workers WHERE status = 'REGISTERED' AND merged_into_id IS NULL;
  RAISE NOTICE 'migration 594: % fichas dispensadas por legado; REGISTERED vivas no corte = %', v_marcadas, v_vivas;
END $$;

-- ─── 4. o dono da completude lê a mesma função (item phone_unverified) ───────────────────────────────────────────
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
  -- ── Celular verificado (emenda 077 §7.2, D779): só "daqui em diante" ────────────
  --   Entra quando HÁ telefone, a ficha não foi dispensada no corte (phone_verification_waived_at IS NULL) e a posse do número
  --   não está provada AGORA. Sem telefone, só `phone` (nunca os dois). O guard e o recálculo leem ESTE dono; nenhuma regra própria.
  IF p_w.phone IS NOT NULL AND p_w.phone <> ''
     AND p_w.phone_verification_waived_at IS NULL
     AND NOT public.fn_worker_phone_is_verified(p_w) THEN
    v_missing := array_append(v_missing, 'phone_unverified');
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
