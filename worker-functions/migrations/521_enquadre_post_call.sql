-- 521 — Esteira pós-call do enquadre (spec 052, Fase 3): o que o fim de call e a importação do Tactiq precisam gravar no evento.
--
--  1. `enquadre_events`: início real da conferência (`conference_started_at`, molde 515), caminho e sha256 da transcrição no
--     cofre do enquadre, e o MOTIVO do `blocked` (o selo da linha do evento mostra o porquê). "Vazio" tem um só significado:
--     `blocked_reason` NULL = não está bloqueado (o CHECK amarra ao `import_status='blocked'`); caminho e sha256 nascem juntos.
--  2. `enquadre_event_participants`: presença medida pelo app (`attendance`: present | absent | unidentified; NULL = ainda não
--     medida) e o método que ligou o participante do Meet ao convocado (`match_method`; só existe quando `present`).
--  3. `enquadre_event_trail`: trilha append-only do evento, no molde de `admission_events` (504): mesmos nomes de etapa (`kind`),
--     trigger que recusa UPDATE e só deixa DELETE quando o evento-mãe já não existe (cascata), e privilégio só de SELECT/INSERT.
--     `ref` guarda SÓ ids, hashes e contagens — nunca texto da transcrição, nome ou e-mail. Sem RLS (molde 518: as tabelas do
--     enquadre são filhas de `job_postings`, que não tem RLS) e SEM FK para paciente.
--  4. `enquadre_event_documents`: o PDF do resumo, ligado ao EVENTO (não ao paciente), no molde da linha que
--     `StoreAdmissionSummaryDocument` grava em `patient_documents`: caminho, nome e rótulo CIFRADOS (KMS), sha256 do arquivo,
--     tamanho, e a versão do prompt. Um documento por evento (UNIQUE). FK RESTRICT (como a 506): o documento não some por cascata
--     calada; o objeto do PDF mora no bucket de documentos.
--
-- Sem BEGIN/COMMIT próprio (o runner envolve cada arquivo). Idempotente (2×).
-- ROLLBACK: migrations/pending/ROLLBACK_521_enquadre_post_call.sql

ALTER TABLE enquadre_events
  ADD COLUMN IF NOT EXISTS conference_started_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS transcript_object_path TEXT NULL,
  ADD COLUMN IF NOT EXISTS transcript_sha256 TEXT NULL,
  ADD COLUMN IF NOT EXISTS blocked_reason TEXT NULL;

ALTER TABLE enquadre_events DROP CONSTRAINT IF EXISTS enquadre_events_transcript_pair;
ALTER TABLE enquadre_events
  ADD CONSTRAINT enquadre_events_transcript_pair CHECK (
    (transcript_object_path IS NULL) = (transcript_sha256 IS NULL)
    AND (transcript_sha256 IS NULL OR transcript_sha256 ~ '^[0-9a-f]{64}$')
  );

ALTER TABLE enquadre_events DROP CONSTRAINT IF EXISTS enquadre_events_blocked_reason_check;
ALTER TABLE enquadre_events
  ADD CONSTRAINT enquadre_events_blocked_reason_check CHECK (
    blocked_reason IS NULL OR ((import_status = 'blocked') IS TRUE AND blocked_reason ~ '^[a-z_]{1,64}$')
  );

ALTER TABLE enquadre_event_participants
  ADD COLUMN IF NOT EXISTS attendance TEXT NULL,
  ADD COLUMN IF NOT EXISTS match_method TEXT NULL;

ALTER TABLE enquadre_event_participants DROP CONSTRAINT IF EXISTS enquadre_participants_attendance_check;
ALTER TABLE enquadre_event_participants
  ADD CONSTRAINT enquadre_participants_attendance_check CHECK (attendance IS NULL OR attendance IN ('present', 'absent', 'unidentified'));

ALTER TABLE enquadre_event_participants DROP CONSTRAINT IF EXISTS enquadre_participants_match_method_check;
ALTER TABLE enquadre_event_participants
  ADD CONSTRAINT enquadre_participants_match_method_check CHECK (
    match_method IS NULL OR (attendance = 'present' AND match_method IN ('display_name_unique'))
  );

-- ── Trilha append-only ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS enquadre_event_trail (
  id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   UUID         NOT NULL REFERENCES enquadre_events(id) ON DELETE CASCADE,
  at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  kind       TEXT         NOT NULL,
  outcome    TEXT         NULL,
  reason     TEXT         NULL,
  -- Só ids: nome do objeto, generation, sha256, contagens. Nunca texto da transcrição, nome nem e-mail.
  ref        JSONB        NULL,
  trace_id   TEXT         NULL
);

CREATE INDEX IF NOT EXISTS idx_enquadre_event_trail_event ON enquadre_event_trail (event_id, at);

-- Append-only (molde fn_admission_events_imutavel, 504): UPDATE nunca; DELETE só quando o evento-mãe já não existe (cascata).
CREATE OR REPLACE FUNCTION fn_enquadre_event_trail_imutavel()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM enquadre_events e WHERE e.id = OLD.event_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'enquadre_event_trail_imutavel: a trilha não se apaga' USING ERRCODE = '55000';
  END IF;
  RAISE EXCEPTION 'enquadre_event_trail_imutavel: a trilha não se edita — registre um evento novo' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enquadre_event_trail_imutavel ON enquadre_event_trail;
CREATE TRIGGER trg_enquadre_event_trail_imutavel
  BEFORE UPDATE OR DELETE ON enquadre_event_trail
  FOR EACH ROW EXECUTE FUNCTION fn_enquadre_event_trail_imutavel();

-- Append-only também nos privilégios (o default do banco concede DELETE; o trigger é a trava forte).
REVOKE UPDATE, DELETE ON enquadre_event_trail FROM app_runtime, app_system;
GRANT SELECT, INSERT ON enquadre_event_trail TO app_runtime, app_system;

-- ── O PDF do resumo, ligado ao evento ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS enquadre_event_documents (
  id                       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id                 UUID         NOT NULL REFERENCES enquadre_events(id) ON DELETE RESTRICT,
  label_encrypted          TEXT         NOT NULL,
  file_path_encrypted      TEXT         NOT NULL,
  original_name_encrypted  TEXT         NOT NULL,
  content_type             TEXT         NOT NULL,
  size_bytes               BIGINT       NOT NULL,
  sha256                   BYTEA        NOT NULL,
  prompt_version           TEXT         NOT NULL,
  created_by_uid           VARCHAR(128) NOT NULL,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT enquadre_event_documents_pdf     CHECK (content_type = 'application/pdf'),
  CONSTRAINT enquadre_event_documents_size    CHECK (size_bytes > 0),
  CONSTRAINT enquadre_event_documents_sha     CHECK (octet_length(sha256) = 32),
  -- um evento gera NO MÁXIMO um resumo (importar 2× = 1 documento)
  CONSTRAINT uq_enquadre_event_documents_event UNIQUE (event_id)
);

REVOKE UPDATE, DELETE ON enquadre_event_documents FROM app_runtime, app_system;
GRANT SELECT, INSERT ON enquadre_event_documents TO app_runtime, app_system;

COMMENT ON COLUMN enquadre_events.conference_started_at IS
  'Menor início de conferência do Meet observado pelo job de fim de call (nunca anda para frente). NULL = nenhuma conferência observada.';
COMMENT ON COLUMN enquadre_events.transcript_object_path IS
  'Nome do objeto da transcrição no cofre do enquadre (<país>/enquadre/<event_id>/transcricao-<sha>.txt). Só o nome: o texto nunca entra no banco.';
COMMENT ON COLUMN enquadre_events.blocked_reason IS
  'Motivo do import_status=blocked (código fechado: meet_scope_missing, no_meet_link, ...). NULL fora do estado blocked.';
COMMENT ON COLUMN enquadre_event_participants.attendance IS
  'Presença medida pelo app (nunca por operador): present | absent | unidentified. NULL = ainda não medida.';
COMMENT ON COLUMN enquadre_event_participants.match_method IS
  'Como o participante do Meet foi ligado ao convocado (display_name_unique). Só existe com attendance=present.';
COMMENT ON TABLE enquadre_event_trail IS
  'Trilha append-only do evento de enquadre (spec 052, molde admission_events). Trigger recusa UPDATE/DELETE. ref guarda SÓ ids.';
COMMENT ON TABLE enquadre_event_documents IS
  'Resumo (PDF) do evento de enquadre: caminho/nome/rótulo cifrados (KMS), sha256 e prompt_version. Ligado ao EVENTO, sem FK para paciente.';
