-- 500 — patients: "Dirección de facturación" como campo PRÓPRIO do paciente (spec 044, D475, Gabriel 07/10/2026).
--
-- Por quê: a D465 tratava o endereço Principal de `patient_addresses` como faturamento. Fato novo do Gabriel
-- (07/10): "Principal" é a RESIDÊNCIA principal; o faturamento é outra coisa. O texto vem da mesma busca do
-- Google Places dos locais, gravado como veio (sem re-geocodar no servidor, sem lat/lng, sem address_components).
--
-- 1) EXPAND: 3 colunas text nullable, sem default, nunca referenciadas por serviço ou vaga.
--    São PII da célula `patient_identity`. Não ganham GRANT para `enlite_mcp_ro` (a role nasce sem acesso às
--    colunas novas; ver create-mcp-ro-role.sql) — nada a fazer aqui.
-- 2) BACKFILL (D5): paciente existente começa com faturamento = endereço Principal ativo
--    (`is_default AND archived_at IS NULL`). Idempotente: só escreve onde `billing_address_formatted IS NULL`,
--    então reexecutar não muda nada e nunca sobrescreve faturamento já preenchido.
--    - COALESCE(address_formatted, address_raw): mesmo critério que o card usa hoje para exibir.
--    - p.deleted_at IS NULL: não copia PII para paciente apagado (minimização).
--    - Principal sem texto nenhum (ambos NULL) não entra: paciente fica NULL ("No definido").
--    - city/state do endereço podem ser NULL (endereço criado pelo painel não grava) — então billing_city /
--      billing_province ficam NULL para esses pacientes.
--    - NÃO toca `updated_at`, para não acordar nada que leia "paciente mudou". Os triggers de `patients` são
--      por coluna (status, deleted_at, emergência) e não disparam com estas colunas.
--
-- ⚠️ Migrations rodam no boot (Dockerfile): o merge na `main` executa este backfill em prd.
-- Rollback: migrations/pending/ROLLBACK_500_patient_billing_address.sql (DROP das 3 colunas).
ALTER TABLE patients
  ADD COLUMN IF NOT EXISTS billing_address_formatted text,
  ADD COLUMN IF NOT EXISTS billing_city text,
  ADD COLUMN IF NOT EXISTS billing_province text;

COMMENT ON COLUMN patients.billing_address_formatted IS
  'Endereço de faturamento (texto formatado do Google Places), campo próprio do paciente (spec 044, D475). '
  'PII da célula patient_identity: nunca em log. Independente do endereço Principal (que é a residência).';
COMMENT ON COLUMN patients.billing_city IS
  'Cidade do endereço de faturamento (Places: locality). PII da célula patient_identity.';
COMMENT ON COLUMN patients.billing_province IS
  'Província do endereço de faturamento (Places: administrative_area_level_1). PII da célula patient_identity.';

UPDATE patients p
   SET billing_address_formatted = COALESCE(pa.address_formatted, pa.address_raw),
       billing_city              = pa.city,
       billing_province          = pa.state
  FROM patient_addresses pa
 WHERE pa.patient_id = p.id
   AND pa.is_default
   AND pa.archived_at IS NULL
   AND p.billing_address_formatted IS NULL
   AND p.deleted_at IS NULL
   AND COALESCE(pa.address_formatted, pa.address_raw) IS NOT NULL;
