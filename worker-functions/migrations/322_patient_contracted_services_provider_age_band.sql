-- 322 — `patient_contracted_services.provider_age_band`: a franja etária solicitada do
-- prestador (spec 015, US-A6.1/US-A6.2)
--
-- D191 (25/08, Gabriel: "só vai") + D254 item 6 (03/09: mapear para a faixa da vaga) + D256
-- (03/09: fazer o enum; nenhum parecer do lex condiciona este item — dado não-clínico, campo do
-- SERVIÇO, mesmo perímetro de `patient_contracted_services`, migration 319).
--
-- ── O que fecha ───────────────────────────────────────────────────────────────
-- `Franja Etaria Solicitada Prestador` (task 86ak0jz2w, campo `job_postings.provider_age_range`
-- no ClickUp) virou citação no cabeçalho da spec 012 e nunca virou task (0 ocorrências em
-- worker-functions/src, medido 03/09). Enum canônico inglês (FR-007 da spec 001): ANY |
-- AGE_20_30 | AGE_30_45 | AGE_45_PLUS — mesmo molde CHECK das outras colunas de
-- `patient_contracted_services` (care_location, contract_type etc., migration 319).
--
-- ── Por que NULL sem DEFAULT ──────────────────────────────────────────────────
-- "Não informado" é um estado válido e distinto de ANY (edad indistinta) — ver
-- `ProviderAgeBandMapping.ts`: `null` não toca a vaga (mantém o que já era gerado antes desta
-- coluna existir, incluindo todo serviço já criado antes desta migration); `ANY` grava
-- `age_range_min=null, age_range_max=null` explicitamente (mesmo resultado numérico, sinal
-- semântico diferente para quem auditar o dado depois).
--
-- ── Ativação propaga só para a vaga do SERVIÇO ────────────────────────────────
-- `ActivatePatientUseCase` lê esta coluna só no braço "paciente com serviço(s) ativo(s)"
-- (migrations 320/321) — o fallback por endereço (paciente sem serviço) fica INTOCADO, sem
-- franja nenhuma (spec 015, FR-3).
--
-- Rollback: DROP CONSTRAINT pcs_provider_age_band_check; DROP COLUMN provider_age_band — nasce
-- NULL em toda linha existente (aditiva, 2× idempotente: ADD COLUMN IF NOT EXISTS + DROP
-- CONSTRAINT IF EXISTS antes do ADD CONSTRAINT).

ALTER TABLE patient_contracted_services
  ADD COLUMN IF NOT EXISTS provider_age_band TEXT NULL;

ALTER TABLE patient_contracted_services DROP CONSTRAINT IF EXISTS pcs_provider_age_band_check;
ALTER TABLE patient_contracted_services
  ADD CONSTRAINT pcs_provider_age_band_check
  CHECK (provider_age_band IS NULL OR provider_age_band IN ('ANY', 'AGE_20_30', 'AGE_30_45', 'AGE_45_PLUS'));

COMMENT ON COLUMN patient_contracted_services.provider_age_band IS
  'Franja etária solicitada do PRESTADOR para este serviço (spec 015, US-A6.1; D191/D254/D256) — '
  'ANY | AGE_20_30 | AGE_30_45 | AGE_45_PLUS, NULL = não informado. Ao ativar, propaga para '
  'job_postings.age_range_min/max da vaga NASCIDA DESTE SERVIÇO (fonte única: '
  'ProviderAgeBandMapping.ts, spec 015) — o fallback por endereço (paciente sem serviço) não é '
  'tocado.';
