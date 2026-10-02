-- Migration 497: `patient_documents` — aba "Documentos" da ficha do paciente (spec 031, D463).
--
-- Uma tabela só de documentos do paciente. Duas portas de entrada gravam nela:
--   * origem 'tab'  — arquivo subido pela aba: o objeto vive no bucket `PATIENT_DOCUMENTS_BUCKET`
--     (`patient-documents/<uuid>.<ext>`); caminho, nome original e rótulo ficam CIFRADOS (KMS).
--   * origem 'chat' — anexo de mensagem do chat: a linha só APONTA para `stored_files` (arquivo NÃO é
--     copiado) e para a mensagem de origem; as colunas de arquivo da aba ficam NULL.
-- `CHECK patient_documents_shape` obriga exatamente um dos dois formatos.
--
-- Nome do documento (`label_encrypted`) é decisão da operadora (D463, Q9) — cifrado em repouso, nunca
-- em log. Só ele (e a trilha de renomear) é UPDATE-ável; o resto é imutável.
-- Exclusão é DEFINITIVA por decisão do Gabriel (02/10/2026): app_runtime tem DELETE.
--
-- `stored_files` NÃO é alterada. A homônima antiga (426, spec 018) foi removida pela 438 e nunca foi a
-- prd; esta é outra tabela, com o mesmo nome. Registro legal: OP-22 (docs/legal/registro-operacoes.md).
--
-- country em 3 etapas (trigger → NOT NULL → CHECK AR/BR), RLS segue o paciente (molde 494/458).
-- `enlite_mcp_ro` NÃO recebe nada (dado sensível-saúde; também em scripts/create-mcp-ro-role.sql).
-- Idempotente (2×). Sem BEGIN/COMMIT próprio.

CREATE TABLE IF NOT EXISTS patient_documents (
  id                      UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id              UUID         NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  country                 TEXT         NULL,  -- etapa 1: trigger abaixo preenche; etapa 2: NOT NULL; etapa 3: CHECK
  origin                  TEXT         NOT NULL,
  label_encrypted         TEXT         NOT NULL,
  -- origem 'tab' (arquivo da aba)
  file_path_encrypted     TEXT         NULL,
  original_name_encrypted TEXT         NULL,
  content_type            TEXT         NULL,
  size_bytes              INTEGER      NULL,
  sha256                  BYTEA        NULL,
  -- origem 'chat' (arquivo do chat, não copiado)
  stored_file_id          UUID         NULL REFERENCES stored_files(id) ON DELETE CASCADE,
  source_message_id       UUID         NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
  created_by_uid          VARCHAR(128) NOT NULL,
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  label_updated_by_uid    VARCHAR(128) NULL,
  label_updated_at        TIMESTAMPTZ  NULL,
  CONSTRAINT patient_documents_origin_check CHECK (origin IN ('tab', 'chat')),
  CONSTRAINT patient_documents_content_type_check CHECK (content_type IS NULL OR content_type IN (
    'application/pdf',
    'image/png',
    'image/jpeg',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  )),
  CONSTRAINT patient_documents_size_check CHECK (size_bytes IS NULL OR size_bytes > 0),
  CONSTRAINT patient_documents_shape CHECK (
    (
      origin = 'tab'
      AND file_path_encrypted IS NOT NULL AND original_name_encrypted IS NOT NULL
      AND content_type IS NOT NULL AND size_bytes IS NOT NULL AND sha256 IS NOT NULL
      AND stored_file_id IS NULL AND source_message_id IS NULL
    ) OR (
      origin = 'chat'
      AND stored_file_id IS NOT NULL AND source_message_id IS NOT NULL
      AND file_path_encrypted IS NULL AND original_name_encrypted IS NULL
      AND content_type IS NULL AND size_bytes IS NULL AND sha256 IS NULL
    )
  )
);

-- Um arquivo do chat vira NO MÁXIMO um documento.
CREATE UNIQUE INDEX IF NOT EXISTS uq_patient_documents_stored_file
  ON patient_documents (stored_file_id) WHERE stored_file_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_patient_documents_patient
  ON patient_documents (patient_id, created_at DESC);

-- ── country: 3 etapas (molde 494) ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_patient_documents_country_from_patient()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.country IS NULL THEN
    SELECT p.country INTO NEW.country FROM patients p WHERE p.id = NEW.patient_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_patient_documents_country ON patient_documents;
CREATE TRIGGER trg_patient_documents_country
  BEFORE INSERT ON patient_documents
  FOR EACH ROW EXECUTE FUNCTION fn_patient_documents_country_from_patient();

ALTER TABLE patient_documents ALTER COLUMN country SET NOT NULL;

ALTER TABLE patient_documents DROP CONSTRAINT IF EXISTS patient_documents_country_check;
ALTER TABLE patient_documents
  ADD CONSTRAINT patient_documents_country_check CHECK (country IN ('AR', 'BR'));

-- ── RLS: segue o paciente (que já filtra por país) — molde 458/494 ─────────────
ALTER TABLE patient_documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS patient_documents_follow_patient ON patient_documents;
CREATE POLICY patient_documents_follow_patient ON patient_documents FOR ALL USING (
  (
    NULLIF(current_setting('app.system_context', true), '') IS NOT NULL
    AND pg_has_role(current_user, 'app_system', 'MEMBER')
  )
  OR EXISTS (SELECT 1 FROM patients p WHERE p.id = patient_documents.patient_id)
);

-- ── GRANT/REVOKE — UPDATE só do rótulo e da trilha de renomear; DELETE (exclusão definitiva) ──
GRANT SELECT, INSERT, DELETE ON patient_documents TO app_runtime, app_system;
GRANT UPDATE (label_encrypted, label_updated_by_uid, label_updated_at) ON patient_documents TO app_runtime, app_system;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'enlite_mcp_ro') THEN
    REVOKE ALL ON patient_documents FROM enlite_mcp_ro;
  END IF;
END
$$;

COMMENT ON TABLE patient_documents IS
  'Documentos do paciente (spec 031, D463): origem tab (arquivo subido na aba) ou chat (aponta para stored_files, nao copia). '
  'Dado sensivel-saude (Ley 25.326 art. 2 e 8; OP-22). Nome/caminho cifrados. Fora do enlite_mcp_ro. Exclusao definitiva.';
COMMENT ON COLUMN patient_documents.label_encrypted IS
  'Nome do documento dado pela operadora (livre, sem regra), cifrado KMS. Unica coluna de conteudo editavel (com a trilha label_updated_*).';
COMMENT ON COLUMN patient_documents.country IS
  'Herdado de patients.country por trigger (etapa 1/3). NOT NULL (etapa 2/3) + CHECK AR/BR (etapa 3/3).';

-- ── Células patient_document:read|create|update|delete + grants iniciais (FR-015) ────────────────
-- Esta migration roda ANTES do sync do catálogo no boot: semeia as 4 células (placeholder, o sync
-- sobrescreve a descrição sem trocar o id) para o grant não depender da ordem migration × boot
-- (molde 463). Grant a Acesso Master (UUID fixo) e ao grupo de Admissão pelo NOME REAL
-- ('Admisión y Supervisión' em prd; AUSENTE na stage — o INSERT ... SELECT casa 0 linhas e segue,
-- nenhum grupo é criado/movido/reativado). Demais grupos: configuração da operação.
-- ROLLBACK: DELETE FROM iam.group_permissions WHERE permission_id IN
--   (SELECT id FROM iam.permissions WHERE resource = 'patient_document');
DO $$
DECLARE
  v_master_id CONSTANT UUID := 'a0000000-0000-0000-0000-000000000001';
  v_n INT;
BEGIN
  IF to_regclass('iam.permissions') IS NOT NULL THEN
    INSERT INTO iam.permissions (resource, action, description, category, owner_service, deprecated_at)
    VALUES
      ('patient_document', 'read',
       '[497 placeholder — sincronizado no boot] Ver a lista de documentos do paciente (aba Documentos) e abrir cada arquivo.',
       'Pacientes', 'worker-functions', NULL),
      ('patient_document', 'create',
       '[497 placeholder — sincronizado no boot] Subir um documento do paciente pela aba Documentos.',
       'Pacientes', 'worker-functions', NULL),
      ('patient_document', 'update',
       '[497 placeholder — sincronizado no boot] Renomear um documento do paciente na lista.',
       'Pacientes', 'worker-functions', NULL),
      ('patient_document', 'delete',
       '[497 placeholder — sincronizado no boot] Excluir um documento do paciente (definitivo).',
       'Pacientes', 'worker-functions', NULL)
    ON CONFLICT (resource, action) DO NOTHING;
  END IF;

  IF to_regclass('iam.permission_groups') IS NOT NULL AND to_regclass('iam.group_permissions') IS NOT NULL THEN
    INSERT INTO iam.group_permissions (group_id, permission_id)
    SELECT v_master_id, p.id
      FROM iam.permissions p
     WHERE p.resource = 'patient_document' AND p.deprecated_at IS NULL
       AND EXISTS (SELECT 1 FROM iam.permission_groups g WHERE g.id = v_master_id)
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE '[497] grant ao Acesso Master: % células patient_document', v_n;

    INSERT INTO iam.group_permissions (group_id, permission_id)
    SELECT g.id, p.id
      FROM iam.permission_groups g
      CROSS JOIN iam.permissions p
     WHERE g.name IN ('Admisión y Supervisión')
       AND g.archived_at IS NULL
       AND p.resource = 'patient_document' AND p.deprecated_at IS NULL
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE '[497] grant ao grupo de Admissão: % células patient_document (0 se o grupo não existe neste banco)', v_n;
  END IF;
END
$$;
