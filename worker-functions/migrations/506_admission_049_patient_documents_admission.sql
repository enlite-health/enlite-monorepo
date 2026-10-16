-- 506 — Aba Admissão (spec 049, F1): documento do paciente com origem `admission`
--
-- POR QUÊ: o resumo da reunião de admissão entra em `patient_documents` (aba Documentos) ligado à reunião que o gerou.
-- `admission` tem a FORMA de `tab` (arquivo no bucket, caminho/nome cifrados) + `source_appointment_id` obrigatório; as formas
-- `tab` e `chat` passam a exigir `source_appointment_id IS NULL`. O índice único faz da importação 2× UM documento só.
--
-- FK é ON DELETE RESTRICT (e não SET NULL): SET NULL violaria o CHECK de forma da própria origem `admission` e abortaria o
-- DELETE da reunião com um 23514 confuso. RESTRICT recusa apagar a reunião que tem documento — quem apaga paciente de teste
-- (PatientTestFixtureService) apaga o documento antes.
--
-- Idempotente (2×). Sem BEGIN/COMMIT próprio fora do bloco abaixo.
-- ROLLBACK: migrations/pending/ROLLBACK_506_admission_049_patient_documents_admission.sql

BEGIN;

ALTER TABLE patient_documents
  ADD COLUMN IF NOT EXISTS source_appointment_id UUID NULL REFERENCES admission_appointments(id) ON DELETE RESTRICT;

ALTER TABLE patient_documents DROP CONSTRAINT IF EXISTS patient_documents_origin_check;
ALTER TABLE patient_documents
  ADD CONSTRAINT patient_documents_origin_check CHECK (origin IN ('tab', 'chat', 'admission'));

ALTER TABLE patient_documents DROP CONSTRAINT IF EXISTS patient_documents_shape;
ALTER TABLE patient_documents
  ADD CONSTRAINT patient_documents_shape CHECK (
    (
      origin = 'tab'
      AND file_path_encrypted IS NOT NULL AND original_name_encrypted IS NOT NULL
      AND content_type IS NOT NULL AND size_bytes IS NOT NULL AND sha256 IS NOT NULL
      AND stored_file_id IS NULL AND source_message_id IS NULL AND source_appointment_id IS NULL
    ) OR (
      origin = 'chat'
      AND stored_file_id IS NOT NULL AND source_message_id IS NOT NULL
      AND file_path_encrypted IS NULL AND original_name_encrypted IS NULL
      AND content_type IS NULL AND size_bytes IS NULL AND sha256 IS NULL
      AND source_appointment_id IS NULL
    ) OR (
      origin = 'admission'
      AND file_path_encrypted IS NOT NULL AND original_name_encrypted IS NOT NULL
      AND content_type IS NOT NULL AND size_bytes IS NOT NULL AND sha256 IS NOT NULL
      AND stored_file_id IS NULL AND source_message_id IS NULL AND source_appointment_id IS NOT NULL
    )
  );

-- Uma reunião gera NO MÁXIMO um documento (importação 2× = 1 documento).
CREATE UNIQUE INDEX IF NOT EXISTS uq_patient_documents_source_appointment
  ON patient_documents (source_appointment_id) WHERE source_appointment_id IS NOT NULL;

COMMENT ON COLUMN patient_documents.source_appointment_id IS
  'Reunião de admissão que gerou o documento (origem admission, spec 049). NULL nas origens tab e chat. FK RESTRICT.';

COMMIT;
