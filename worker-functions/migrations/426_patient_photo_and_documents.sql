-- 426 — foto do paciente, consentimento de imagem e documento de prova (spec 018, PR-4, US-9).
--
-- Escopo TÉCNICO-SEGURANÇA (mantido integralmente): 2 buckets privados separados (foto vs
-- documento/prova), caminho cifrado por KMS com nome UUID, `patient_documents` append-only
-- (REVOKE UPDATE/DELETE de app_runtime — sai só pelo CASCADE da purga do paciente), órfãos com
-- coluna `bucket` para cobrir os 2 buckets, tabelas fora do `enlite_mcp_ro` (revogadas no mesmo
-- commit, script à parte) e fora do SKIP_TABLES da cópia prd→stg (reportado ao ebrain, fora deste
-- repo).
--
-- Decisão do Gabriel (14/09) — o que este schema NÃO tem, ao contrário do desenho legal original
-- de `data-model.md:135-233`:
--   * `patient_image_consents.document_id` é OPCIONAL (NULL permitido) — registrar consentimento
--     não exige mais prova documental (C3 removida). FK composta continua existindo, mas só é
--     verificada quando o valor não é NULL (MATCH SIMPLE, padrão do Postgres em FK composta).
--   * Upload de foto NÃO checa consentimento vigente (L1b removida) — sem 409 `IMAGE_CONSENT_REQUIRED`.
--   * Menor/incapaz sem representante NÃO bloqueia upload (L1b' removida) — sem 422 `REPRESENTATIVE_REQUIRED`
--     na tabela; `representation_basis`/`representation_verified_by`/`representation_verified_at`
--     continuam existindo porque cadastrar/exibir/editar representante segue sendo funcionalidade.
--   * Revogação (C5) fica simples: apaga a foto (linha + objeto); SEM regra de retenção/prova de
--     revogação como trava legal (`revoked_by`/`revocation_channel`/`revocation_document_id`
--     continuam como campos de registro, não como constraint bloqueante).
--   * Sem CHECK de país (BR/US → 422, C14) — decisão de país não é regra de schema.
--
-- Molde de satélite de patients: country por trigger, RLS follow_patient, GRANT explícito, REVOKE
-- do `enlite_mcp_ro` fora daqui (role pode não existir no banco — 422_patient_external_contacts.sql:78-84),
-- CASCADE_CHILDREN + SKIP_TABLES reportados à parte (PatientTestFixtureService.ts / ebrain).
--
-- Rollback: DROP TRIGGER/FUNCTION/POLICY e DROP TABLE (ordem inversa de dependência) — nasce vazia.

CREATE TABLE IF NOT EXISTS patient_documents (   -- prova de consentimento/revogação; NUNCA a foto
  id                     UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id             UUID         NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  country                TEXT         NULL,                 -- trigger → SET NOT NULL → CHECK IN ('AR','BR')
  document_type          TEXT         NOT NULL CHECK (document_type IN ('image_consent','image_consent_revocation')),
  object_path_encrypted  TEXT         NOT NULL,             -- KMS; bucket PRÓPRIO, separado do da foto
  content_type           TEXT         NOT NULL CHECK (content_type IN ('application/pdf','image/jpeg')),
  size_bytes             BIGINT       NOT NULL CHECK (size_bytes > 0),
  sha256                 TEXT         NOT NULL,
  uploaded_by            VARCHAR(128) NOT NULL,             -- uid, nunca e-mail
  uploaded_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT pdoc_id_patient_uq UNIQUE (id, patient_id)      -- alvo das FKs compostas de patient_image_consents
);
-- Sem label/notas/status/updated_at (append-only por desenho). REVOKE UPDATE, DELETE logo abaixo —
-- sai só pelo CASCADE da purga do paciente.

CREATE TABLE IF NOT EXISTS patient_image_consents (
  id                          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id                  UUID         NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  consenter_kind              TEXT         NOT NULL CHECK (consenter_kind IN ('PATIENT','REPRESENTATIVE')),
  responsible_id              UUID         NULL,                       -- obrigatório (coerência) se REPRESENTATIVE
  document_id                 UUID         NULL,                       -- OPCIONAL (decisão 14/09) — prova quando existir
  text_version                TEXT         NOT NULL,                   -- versão do texto aprovado pelo jurídico
  consented_at                TIMESTAMPTZ  NOT NULL,
  recorded_by                 VARCHAR(128) NOT NULL,
  revoked_at                  TIMESTAMPTZ  NULL,
  revoked_by                  VARCHAR(128) NULL,
  revocation_channel          TEXT         NULL CHECK (revocation_channel IN ('WRITTEN','EMAIL','IN_PERSON','PHONE')),
  revocation_document_id      UUID         NULL,                       -- opcional — revogar sem documento é válido
  representation_basis        TEXT         NULL CHECK (representation_basis IN ('PARENTAL_RESPONSIBILITY','GUARDIAN_DESIGNATION')),
  representation_verified_by  VARCHAR(128) NULL,
  representation_verified_at  TIMESTAMPTZ  NULL,
  country                     TEXT         NULL,
  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT pic_rep_coerente CHECK ((consenter_kind = 'REPRESENTATIVE') = (responsible_id IS NOT NULL)),
  CONSTRAINT pic_resp_fk FOREIGN KEY (responsible_id, patient_id) REFERENCES patient_responsibles(id, patient_id),
  CONSTRAINT pic_doc_fk FOREIGN KEY (document_id, patient_id) REFERENCES patient_documents(id, patient_id),
  CONSTRAINT pic_revoke_doc_fk FOREIGN KEY (revocation_document_id, patient_id) REFERENCES patient_documents(id, patient_id),
  CONSTRAINT pic_revoked_by_coerente CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_patient_image_consents_vigente ON patient_image_consents(patient_id) WHERE revoked_at IS NULL;
-- 1 vigente por paciente; revogar + novo consentimento = linhas NOVAS (nunca reescreve document_id/objeto).
CREATE INDEX IF NOT EXISTS idx_patient_image_consents_patient ON patient_image_consents(patient_id);

CREATE TABLE IF NOT EXISTS patient_photos (
  id                     UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id             UUID         NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  consent_id             UUID         NULL REFERENCES patient_image_consents(id),   -- opcional (decisão 14/09: upload não exige consentimento vigente)
  object_path_encrypted  TEXT         NOT NULL,             -- KMS; molde workers.profile_photo_url_encrypted (023_…sql:203)
  content_type           TEXT         NOT NULL CHECK (content_type IN ('image/jpeg')),   -- re-encode sempre sai JPEG
  country                TEXT         NULL,
  created_by             VARCHAR(128) NOT NULL,
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_patient_photos_one ON patient_photos(patient_id);   -- 1 foto viva por paciente

CREATE TABLE IF NOT EXISTS patient_photo_orphans (          -- objeto que o GCS não conseguiu apagar
  id                     UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  object_path_encrypted  TEXT         NOT NULL,
  bucket                 TEXT         NOT NULL DEFAULT 'PHOTOS' CHECK (bucket IN ('PHOTOS','DOCUMENTS')),
  reason                 TEXT         NOT NULL CHECK (reason IN ('REPLACE','PURGE','REVOKE','DELETE')),
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- país FORÇADO a partir do pai em todo INSERT/UPDATE, para as 3 tabelas que carregam patient_id
-- diretamente (patient_photo_orphans não tem patient_id — não recebe trigger de país).
CREATE OR REPLACE FUNCTION fn_patient_documents_country_from_patient()
RETURNS TRIGGER AS $$
BEGIN
  SELECT p.country INTO NEW.country FROM patients p WHERE p.id = NEW.patient_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_patient_documents_country ON patient_documents;
CREATE TRIGGER trg_patient_documents_country
  BEFORE INSERT OR UPDATE ON patient_documents
  FOR EACH ROW EXECUTE FUNCTION fn_patient_documents_country_from_patient();

ALTER TABLE patient_documents ALTER COLUMN country SET NOT NULL;
ALTER TABLE patient_documents DROP CONSTRAINT IF EXISTS pdoc_country_check;
ALTER TABLE patient_documents ADD CONSTRAINT pdoc_country_check CHECK (country IN ('AR', 'BR'));

CREATE OR REPLACE FUNCTION fn_patient_image_consents_country_from_patient()
RETURNS TRIGGER AS $$
BEGIN
  SELECT p.country INTO NEW.country FROM patients p WHERE p.id = NEW.patient_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_patient_image_consents_country ON patient_image_consents;
CREATE TRIGGER trg_patient_image_consents_country
  BEFORE INSERT OR UPDATE ON patient_image_consents
  FOR EACH ROW EXECUTE FUNCTION fn_patient_image_consents_country_from_patient();

ALTER TABLE patient_image_consents ALTER COLUMN country SET NOT NULL;
ALTER TABLE patient_image_consents DROP CONSTRAINT IF EXISTS pic_country_check;
ALTER TABLE patient_image_consents ADD CONSTRAINT pic_country_check CHECK (country IN ('AR', 'BR'));

CREATE OR REPLACE FUNCTION fn_patient_photos_country_from_patient()
RETURNS TRIGGER AS $$
BEGIN
  SELECT p.country INTO NEW.country FROM patients p WHERE p.id = NEW.patient_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_patient_photos_country ON patient_photos;
CREATE TRIGGER trg_patient_photos_country
  BEFORE INSERT OR UPDATE ON patient_photos
  FOR EACH ROW EXECUTE FUNCTION fn_patient_photos_country_from_patient();

ALTER TABLE patient_photos ALTER COLUMN country SET NOT NULL;
ALTER TABLE patient_photos DROP CONSTRAINT IF EXISTS pphoto_country_check;
ALTER TABLE patient_photos ADD CONSTRAINT pphoto_country_check CHECK (country IN ('AR', 'BR'));

-- RLS de país: segue o paciente (molde 413/422). patient_photo_orphans não referencia patient_id
-- diretamente (é fila operacional interna, sem dado de país) — sem RLS follow_patient.
ALTER TABLE patient_documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS patient_documents_follow_patient ON patient_documents;
CREATE POLICY patient_documents_follow_patient ON patient_documents FOR ALL USING (
  (
    NULLIF(current_setting('app.system_context', true), '') IS NOT NULL
    AND pg_has_role(current_user, 'app_system', 'MEMBER')
  )
  OR EXISTS (SELECT 1 FROM patients p WHERE p.id = patient_documents.patient_id)
);

ALTER TABLE patient_image_consents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS patient_image_consents_follow_patient ON patient_image_consents;
CREATE POLICY patient_image_consents_follow_patient ON patient_image_consents FOR ALL USING (
  (
    NULLIF(current_setting('app.system_context', true), '') IS NOT NULL
    AND pg_has_role(current_user, 'app_system', 'MEMBER')
  )
  OR EXISTS (SELECT 1 FROM patients p WHERE p.id = patient_image_consents.patient_id)
);

ALTER TABLE patient_photos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS patient_photos_follow_patient ON patient_photos;
CREATE POLICY patient_photos_follow_patient ON patient_photos FOR ALL USING (
  (
    NULLIF(current_setting('app.system_context', true), '') IS NOT NULL
    AND pg_has_role(current_user, 'app_system', 'MEMBER')
  )
  OR EXISTS (SELECT 1 FROM patients p WHERE p.id = patient_photos.patient_id)
);

-- GRANT explícito (molde 419/422; sem ALTER DEFAULT PRIVILEGES).
GRANT SELECT, INSERT, UPDATE, DELETE ON patient_image_consents TO app_runtime, app_system;
GRANT SELECT, INSERT, UPDATE, DELETE ON patient_photos TO app_runtime, app_system;
GRANT SELECT, INSERT, DELETE ON patient_photo_orphans TO app_system;   -- fila interna, só o processo de retry mexe
GRANT SELECT, INSERT ON patient_documents TO app_runtime;              -- append-only: sem UPDATE/DELETE para app_runtime
GRANT SELECT, INSERT, UPDATE, DELETE ON patient_documents TO app_system;  -- purga (CASCADE) roda como app_system

-- `patient_documents` é append-only para o cliente: sai só pelo CASCADE da purga do paciente
-- (lex-documentos #2, TRAVA). REVOKE explícito além do GRANT seletivo acima, para o caso de
-- `app_runtime` já ter UPDATE/DELETE por um GRANT anterior mais amplo (defesa em profundidade).
REVOKE UPDATE, DELETE ON patient_documents FROM app_runtime;

-- REVOKE do `enlite_mcp_ro` NÃO aqui (role pode não existir no banco onde esta migration roda —
-- mesmo padrão de 422_patient_external_contacts.sql:78-84). As 3 tabelas com patient_id
-- (patient_documents, patient_image_consents, patient_photos) e `patient_photo_orphans` já foram
-- adicionadas às listas de REVOKE em `scripts/create-mcp-ro-role.sql` no MESMO commit desta
-- migration (prova: `grep -n "patient_documents\|patient_image_consents\|patient_photos\|patient_photo_orphans" scripts/create-mcp-ro-role.sql`).

COMMENT ON TABLE patient_documents IS
  'Prova documental de consentimento/revogação de imagem (spec 018 PR-4, US-9, lex-documentos D329). '
  'Append-only: REVOKE UPDATE/DELETE de app_runtime, sai só pelo CASCADE da purga. Bucket PRÓPRIO '
  '(separado da foto e de enlite-worker-documents). Decisão 14/09: document_id em '
  'patient_image_consents é OPCIONAL — esta tabela existe mas não é pré-requisito bloqueante.';
COMMENT ON TABLE patient_image_consents IS
  'Consentimento de uso de imagem do paciente. Decisão 14/09: registrar é opcional, NÃO bloqueia '
  'upload de foto (sem 409/422 de pré-requisito). document_id nulo é válido. representation_basis '
  'documenta o representante quando existir, sem checagem bloqueante de menor/incapaz.';
COMMENT ON TABLE patient_photos IS
  'Foto de perfil do paciente (1 viva por paciente, uq_patient_photos_one). Re-encode sempre JPEG, '
  'sem EXIF/GPS (PatientPhotoProcessor). consent_id é OPCIONAL (decisão 14/09).';
COMMENT ON TABLE patient_photo_orphans IS
  'Fila de retry de objeto GCS que não foi apagado (foto ou documento — coluna bucket cobre os 2).';
