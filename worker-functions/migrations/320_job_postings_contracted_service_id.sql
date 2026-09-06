-- 320 — `job_postings.contracted_service_id`: a vaga nasce de um serviço (spec 013, bloco C)
--
-- Decisão 1 do Gabriel (03/09): "entidade própria; vaga referencia". `ON DELETE RESTRICT` (molde
-- 149, `patient_address_id`) — apagar não existe para `patient_contracted_services` (baixa é
-- `active=false`), então RESTRICT nunca dispara na operação normal; existe como cinto de
-- segurança contra um DELETE manual que esqueça a regra.
--
-- `POST /patients/:id/activate` passa a criar uma vaga por (serviço ATIVO × endereço ATIVO)
-- quando o paciente tem serviço(s) contratado(s) declarado(s); sem nenhum serviço ativo, cai no
-- comportamento anterior (uma vaga por endereço, sem contracted_service_id) — nenhum paciente
-- hoje tem serviço declarado (a tabela nasce vazia), e não seria coerente parar de gerar vaga
-- para todo mundo até a operação migrar para o novo drawer. Ver ActivatePatientUseCase.ts.
--
-- Rollback: DROP COLUMN contracted_service_id — nasce NULL em toda vaga existente.

ALTER TABLE job_postings
  ADD COLUMN IF NOT EXISTS contracted_service_id UUID
    REFERENCES patient_contracted_services(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_job_postings_contracted_service_id
  ON job_postings (contracted_service_id)
  WHERE contracted_service_id IS NOT NULL;

COMMENT ON COLUMN job_postings.contracted_service_id IS
  'De qual serviço contratado esta vaga nasceu (spec 013, bloco C). NULL para vaga criada antes '
  'desta migration, ou por paciente sem serviço declarado (ActivatePatientUseCase cai no '
  'fallback por endereço). Só campos CODIFICADOS propagam do serviço para a vaga — weekly_hours, '
  'providers_needed, dispositivos, care_location. worker_profile_sought/salary_text NUNCA '
  'nascem do serviço (lex C-b2/C-c.3).';
