-- 312 — `patient_insurance_verified.provider_code`: o CÓDIGO ao lado do cru (spec 012, US-B3)
--
-- A 305 gravou só `raw_label` (o literal do ClickUp). Agora que o catálogo existe (311), cada
-- linha ganha o código canônico — NULL quando o rótulo não está no ConceptMap (rótulo novo no
-- ClickUp que ninguém mapeou ainda). O cru NÃO é apagado: é a reversibilidade (D-A.2/D-B).
--
-- ── Quem preenche a coluna daqui para a frente ──────────────────────────────
--   - sync do ClickUp: `PatientInsuranceVerifiedRepository.replaceForPatient` traduz por alias
--     no momento da escrita (mesmo ConceptMap deste backfill);
--   - painel: `replaceCodesForPatient` grava código escolhido no select (source='admin_manual').
--
-- ── lex C3.1 ────────────────────────────────────────────────────────────────
-- `patient_insurance_verified` está REVOGADA do `enlite_mcp_ro` por TABELA
-- (create-mcp-ro-role.sql, bloco `unnest(ARRAY['patient_insurance_verified', ...])`). Coluna nova
-- não reabre nada: não há GRANT de coluna nesta tabela. Prova: `tests/e2e/mcp-ro-role.e2e.test.ts`.
--
-- Rollback: `ALTER TABLE patient_insurance_verified DROP COLUMN provider_code;` — o cru fica.

ALTER TABLE patient_insurance_verified
  ADD COLUMN IF NOT EXISTS provider_code TEXT NULL;

-- FK separada do ADD COLUMN para ser idempotente por nome (ADD COLUMN IF NOT EXISTS com REFERENCES
-- inline não é re-executável quando a coluna já existe e a constraint não).
ALTER TABLE patient_insurance_verified
  DROP CONSTRAINT IF EXISTS patient_insurance_verified_provider_code_fkey;
ALTER TABLE patient_insurance_verified
  ADD CONSTRAINT patient_insurance_verified_provider_code_fkey
  FOREIGN KEY (provider_code) REFERENCES insurance_providers(code) ON UPDATE CASCADE;

-- Backfill pelo ConceptMap: só onde ainda é NULL (re-rodar não sobrescreve escolha do painel).
UPDATE patient_insurance_verified piv
   SET provider_code = a.code
  FROM insurance_provider_aliases a
 WHERE piv.provider_code IS NULL
   AND a.source = 'clickup'
   AND a.label  = piv.raw_label;

-- Composto (código, paciente): "quais pacientes têm OSDE?" vira index-only scan (mesma razão da 307).
CREATE INDEX IF NOT EXISTS idx_patient_insurance_verified_code
  ON patient_insurance_verified (provider_code, patient_id)
  WHERE provider_code IS NOT NULL;

COMMENT ON COLUMN patient_insurance_verified.provider_code IS
  'Código canônico da cobertura (FK insurance_providers.code, migration 312). NULL = rótulo cru '
  'sem alias no ConceptMap. O cru (`raw_label`) continua sendo a verdade da ORIGEM. ⚠️ Revela '
  'afiliação sindical por inferência (lex C3.1): tabela inteira fora do enlite_mcp_ro.';
