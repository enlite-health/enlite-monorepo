-- ROLLBACK_506_admission_049_patient_documents_admission.sql — par de rollback da migration 506 (spec 049).
-- ATENÇÃO: apaga os documentos de origem `admission` (o objeto no bucket NÃO é apagado). Reverter o código ANTES.
DELETE FROM patient_documents WHERE origin = 'admission';
DROP INDEX IF EXISTS uq_patient_documents_source_appointment;
ALTER TABLE patient_documents DROP CONSTRAINT IF EXISTS patient_documents_shape;
ALTER TABLE patient_documents DROP CONSTRAINT IF EXISTS patient_documents_origin_check;
ALTER TABLE patient_documents DROP COLUMN IF EXISTS source_appointment_id;
ALTER TABLE patient_documents ADD CONSTRAINT patient_documents_origin_check CHECK (origin IN ('tab', 'chat'));
ALTER TABLE patient_documents ADD CONSTRAINT patient_documents_shape CHECK (
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
);
