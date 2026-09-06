-- Migration 294: "instrucciones de emergencia" do paciente (REQ-01 · D211.2)
--
-- Campo de texto livre (teto 4.000, validado na API) com autoria da última edição, molde de
-- additional_comments (mig 286). SEM cifra — decisão humana do Gabriel (D211.2): "se ele não puder
-- ler, nós não mostramos". A restrição de leitura mora num ÚNICO ponto no servidor
-- (canReadPatientClinical → célula `patient_clinical:read` quando o ABAC chegar); o valor NUNCA
-- vai para trilha/log. Aditiva: três colunas nullable.
ALTER TABLE patients
  ADD COLUMN IF NOT EXISTS emergency_instructions TEXT,
  ADD COLUMN IF NOT EXISTS emergency_instructions_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS emergency_instructions_updated_by VARCHAR(128);

COMMENT ON COLUMN patients.emergency_instructions IS
  'Instruções de emergência do paciente (texto clínico livre, teto 4.000). Leitura autorizada em um único ponto (patient_clinical:read). Nunca em log.';
COMMENT ON COLUMN patients.emergency_instructions_updated_at IS
  'Quando emergency_instructions foi editado pela última vez pelo painel (NULL = nunca).';
COMMENT ON COLUMN patients.emergency_instructions_updated_by IS
  'firebase_uid do staff que fez a última edição. Nome resolvido na leitura (users). Nunca o valor.';
