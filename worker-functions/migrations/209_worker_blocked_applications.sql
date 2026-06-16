-- Migration 209: worker_blocked_applications — instrumentação de tentativas de postulação bloqueadas.
--
-- Registra todas as tentativas de postulação rejeitadas por assertWorkerCanApply,
-- sem alterar o gate de elegibilidade. O 403 continua sendo emitido normalmente.
--
-- Motivos de bloqueio:
--   worker_not_found        — worker não existe ou foi mesclado
--   registration_incomplete — worker existe mas status != 'REGISTERED'
--   worker_disabled         — worker.status = 'DISABLED'
--
-- Isolamento: esta tabela NÃO usa FK para workers nem job_postings para tolerar
-- workers mesclados (merged_into_id) e vagas removidas via soft-delete (archived_at).
-- Ver migrações 183 e 189 que introduziram esses ciclos de vida.
--
-- INVARIANTE: a função fn_worker_missing_fields abaixo DEVE ser mantida em
-- sincronia com fn_guard_registered_status (criada/atualizada pela migration 208).
-- QUALQUER migration futura que altere o guard de status (campos obrigatórios, tabelas
-- satélite, documentos exigidos) DEVE atualizar esta função também.

-- ─── Tabela principal ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS worker_blocked_applications (
  id                   UUID         NOT NULL DEFAULT gen_random_uuid(),
  worker_id            UUID         NOT NULL,
  job_posting_id       UUID         NOT NULL,
  blocked_reason       TEXT         NOT NULL,
  missing_fields       JSONB        NOT NULL DEFAULT '[]',
  attempt_count        INTEGER      NOT NULL DEFAULT 1,
  first_attempted_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_attempted_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  acquisition_channel  TEXT         NULL,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT worker_blocked_applications_pkey PRIMARY KEY (id),
  CONSTRAINT worker_blocked_applications_reason_check
    CHECK (blocked_reason IN ('worker_not_found', 'registration_incomplete', 'worker_disabled'))
);

COMMENT ON TABLE worker_blocked_applications IS
  'Instrumentação de tentativas de postulação bloqueadas por assertWorkerCanApply. '
  'Sem FK para workers/job_postings — tolera merges e soft-deletes. '
  'Isolado dos triggers das migrations 183 e 189.';

COMMENT ON COLUMN worker_blocked_applications.blocked_reason IS
  'Motivo canônico do bloqueio: worker_not_found | registration_incomplete | worker_disabled';

COMMENT ON COLUMN worker_blocked_applications.missing_fields IS
  'Array JSONB de campos/tabelas ausentes, gerado por fn_worker_missing_fields(). '
  'Vazio ([]) quando blocked_reason = worker_not_found ou worker_disabled.';

COMMENT ON COLUMN worker_blocked_applications.attempt_count IS
  'Contador acumulado de tentativas para o mesmo par (worker_id, job_posting_id).';

COMMENT ON COLUMN worker_blocked_applications.acquisition_channel IS
  'Canal de aquisição da tentativa (facebook, instagram, etc.). '
  'First-value-wins: uma vez preenchido não é sobrescrito (COALESCE).';

-- ─── Unique index — chave do upsert ───────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS uq_worker_blocked_applications_worker_job
  ON worker_blocked_applications (worker_id, job_posting_id);

-- ─── Índices de suporte para queries de operadores ────────────────────────────

CREATE INDEX IF NOT EXISTS idx_wba_worker_id
  ON worker_blocked_applications (worker_id);

CREATE INDEX IF NOT EXISTS idx_wba_job_posting_id
  ON worker_blocked_applications (job_posting_id);

CREATE INDEX IF NOT EXISTS idx_wba_blocked_reason
  ON worker_blocked_applications (blocked_reason);

CREATE INDEX IF NOT EXISTS idx_wba_last_attempted_at
  ON worker_blocked_applications (last_attempted_at DESC);

-- ─── Função SSOT de campos faltantes ──────────────────────────────────────────
-- Espelha EXATAMENTE a lógica de fn_guard_registered_status (migration 208).
-- Retorna JSONB array com os nomes dos campos/tabelas faltantes.
-- Trata worker inexistente retornando ["worker_not_found"].
--
-- INVARIANTE: esta função deve ser atualizada toda vez que fn_guard_registered_status
-- for alterada (novos campos obrigatórios, novos documentos, novas tabelas satélite).

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

  -- ── Documentos (espelha fn_guard_registered_status — policy da migration 207) ──
  --   Todos: identity_document_url + identity_document_back_url + criminal_record_url
  --   AT:   também resume_cv_url + at_certificate_url
  IF NOT EXISTS (
    SELECT 1 FROM worker_documents wd
    WHERE wd.worker_id = p_worker_id
      AND wd.identity_document_url      IS NOT NULL
      AND wd.identity_document_back_url IS NOT NULL
      AND wd.criminal_record_url        IS NOT NULL
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
  'SSOT de completude: espelha fn_guard_registered_status (migration 208). '
  'INVARIANTE: atualizar esta função junto a fn_guard_registered_status em toda '
  'migration que altere os requisitos de REGISTERED.';
