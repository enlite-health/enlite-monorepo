BEGIN;

CREATE TABLE IF NOT EXISTS stored_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket text NOT NULL,
  object_path_encrypted text NOT NULL,
  original_name_encrypted text NOT NULL,
  content_type text NOT NULL CHECK (content_type IN (
    'application/pdf',
    'image/png',
    'image/jpeg',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  )),
  size_bytes integer NOT NULL CHECK (size_bytes > 0),
  sha256 bytea NOT NULL,
  scan_status text NOT NULL DEFAULT 'SKIPPED' CHECK (scan_status IN ('SKIPPED', 'PENDING', 'CLEAN', 'INFECTED')),
  uploaded_by_uid varchar(128) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz NULL
);

COMMENT ON COLUMN stored_files.object_path_encrypted IS
  'Cifrado via KMSEncryptionService, padrão PatientPhotoStorage — o caminho no bucket nunca fica em claro no banco.';
COMMENT ON COLUMN stored_files.original_name_encrypted IS
  'Cifrado — pode conter nome de paciente/dado identificável (D-02). Decifrado só no download, sob célula.';
COMMENT ON COLUMN stored_files.scan_status IS
  'Nasce SKIPPED (sem antivírus na v1, F6). Enum fechado — CHECK, não FK, porque a lista é de domínio fixo.';

CREATE TABLE IF NOT EXISTS conversation_message_attachments (
  message_id uuid NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES stored_files(id) ON DELETE RESTRICT,
  PRIMARY KEY (message_id, file_id)
);

GRANT SELECT, INSERT ON stored_files TO app_runtime, app_system;
-- Sem UPDATE de object_path_encrypted (D-02): arquivo é imutável após upload; só deleted_at muda.
GRANT UPDATE (deleted_at, scan_status) ON stored_files TO app_runtime, app_system;
GRANT SELECT, INSERT ON conversation_message_attachments TO app_runtime, app_system;

COMMIT;
