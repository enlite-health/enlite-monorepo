-- 316 — `patient_addresses`: logística POR ENDEREÇO + `country` (spec 012, US-B2; lex C2.1-C2.8)
--
-- A task do Javier pede `Corredor Logístico` e `Logística y Acceso` POR DOMICÍLIO (o ClickUp
-- tem um por paciente). Zona/Bairro NÃO nasce aqui: `neighborhood` já existe desde a 147 e é o
-- mesmo campo ("Zona o Barrio Paciente") — coluna duplicada seria dado excessivo (lex C2.7,
-- art. 4 inc. 1) e duas verdades.
--
-- ── `access_notes` é texto livre sobre o domicílio de um paciente (lex C2) ──
--   C2.1 negado ao `enlite_mcp_ro`: hoje a tabela tem GRANT de TABELA INTEIRA (create-mcp-ro-
--        role.sql:87) — coluna nova nasceria LEGÍVEL pelo conector de LLM no dia 1. O script
--        passa a listar `patient_addresses` no bloco por coluna (`excluir => access_notes`) e na
--        trava fail-closed. Prova: mcp-ro-role.e2e.test.ts.
--   C2.3 nunca em log/erro (o controller loga {patientId, campo, tamanho}).
--   C2.4 `data-clarity-mask` no bloco da ficha.
--   C2.5 fora de `patient_field_overrides_audit` (não passa por vacancyCrudAuditHelpers).
--   C2.6 teto no servidor: 2000 (CHECK + zod).
--
-- ── `country NOT NULL` sem DEFAULT (FR-B2, lex C2.8) ────────────────────────
-- Tabela por paciente leva `country` para a RLS da F1. Sem DEFAULT: um default 'AR' carimbaria
-- endereço BR como AR em silêncio (a pegadinha do DROP DEFAULT da F1). Mas há 5 escritores em
-- `src/` + ~20 INSERTs em testes que não sabem da coluna — exigir o valor em cada um é a fiação
-- que ninguém liga. ⇒ trigger BEFORE INSERT deriva de `patients.country` quando não vier
-- (jurisdição derivada da FK obrigatória — a mesma cláusula C-A das tabelas satélite). O
-- controller do painel passa o país explicitamente mesmo assim.
--
-- Rollback: DROP TRIGGER/FUNCTION; DROP COLUMN logistics_corridor, access_notes, country.

ALTER TABLE patient_addresses
  ADD COLUMN IF NOT EXISTS logistics_corridor TEXT NULL,
  ADD COLUMN IF NOT EXISTS access_notes       TEXT NULL,
  ADD COLUMN IF NOT EXISTS country            TEXT NULL;

ALTER TABLE patient_addresses DROP CONSTRAINT IF EXISTS patient_addresses_access_notes_len;
ALTER TABLE patient_addresses
  ADD CONSTRAINT patient_addresses_access_notes_len
  CHECK (access_notes IS NULL OR length(access_notes) <= 2000);

ALTER TABLE patient_addresses DROP CONSTRAINT IF EXISTS patient_addresses_logistics_corridor_len;
ALTER TABLE patient_addresses
  ADD CONSTRAINT patient_addresses_logistics_corridor_len
  CHECK (logistics_corridor IS NULL OR length(logistics_corridor) <= 200);

-- Backfill do país pelo paciente (idempotente: só onde falta).
UPDATE patient_addresses pa
   SET country = p.country
  FROM patients p
 WHERE p.id = pa.patient_id
   AND pa.country IS NULL;

CREATE OR REPLACE FUNCTION fn_patient_addresses_country_from_patient()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.country IS NULL THEN
    SELECT p.country INTO NEW.country FROM patients p WHERE p.id = NEW.patient_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_patient_addresses_country ON patient_addresses;
CREATE TRIGGER trg_patient_addresses_country
  BEFORE INSERT ON patient_addresses
  FOR EACH ROW EXECUTE FUNCTION fn_patient_addresses_country_from_patient();

-- Só depois do backfill e do trigger: NOT NULL, sem DEFAULT.
ALTER TABLE patient_addresses ALTER COLUMN country SET NOT NULL;

ALTER TABLE patient_addresses DROP CONSTRAINT IF EXISTS patient_addresses_country_check;
ALTER TABLE patient_addresses
  ADD CONSTRAINT patient_addresses_country_check CHECK (country IN ('AR', 'BR'));

CREATE INDEX IF NOT EXISTS idx_patient_addresses_country
  ON patient_addresses (country);

COMMENT ON COLUMN patient_addresses.logistics_corridor IS
  'Corredor logístico do domicílio (ClickUp "Corredor Logístico", só em Estado de Pacientes). '
  'Manual, por endereço. Migration 316, spec 012 US-B2.';
COMMENT ON COLUMN patient_addresses.access_notes IS
  'Logística e acesso ao domicílio — TEXTO LIVRE sobre a casa de um paciente. Negado ao '
  'enlite_mcp_ro (lex C2.1), nunca em log/erro (C2.3), mascarado no Clarity (C2.4), fora de '
  'patient_field_overrides_audit (C2.5), teto 2000 (C2.6). Migration 316.';
COMMENT ON COLUMN patient_addresses.country IS
  'Jurisdição do endereço (AR|BR), NOT NULL sem DEFAULT (FR-B2, lex C2.8). Derivada de '
  'patients.country por trigger quando o escritor não a informa. Migration 316.';
