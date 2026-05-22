-- ============================================================================
-- Migration 184: create patient_health_insurance + backfill member_id
-- ============================================================================
-- Context: Sprint refactor — consolida cobertura médica numa tabela própria.
-- Cumpre TODO da mig 147 ("migrar para tabela patient_health_insurance separada
-- quando houver mais campos de plano").
--
-- Cardinalidade: 1:1 com patients (UNIQUE em patient_id). O domínio atual tem
-- um plano por paciente. Histórico/múltiplos planos não estão no escopo.
--
-- Backfill: das 5 colunas legadas de cobertura em `patients`
-- (insurance_informed, insurance_verified, affiliate_id, health_insurance_name,
-- health_insurance_member_id), apenas health_insurance_member_id tem dados em
-- prod (187/320 pacientes ativos — verificado via DBA 2026-05-22). As outras
-- 4 estão 100% NULL. Backfill copia só member_id, com sanitização do bug de
-- serialização (38 registros contêm a string literal 'null' em vez de SQL NULL).
--
-- Próximas migrations:
--   185 — rename das 8 colunas legadas (cobertura + localização deprecada mig 083)
--   186 — DROP final após N dias estáveis em prod
-- ============================================================================

BEGIN;

-- ── 1. Schema ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS patient_health_insurance (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id          UUID         NOT NULL REFERENCES patients(id) ON DELETE CASCADE,

  -- Operadora (ClickUp: "Cobertura Informada"). Ex: "OSDE", "Swiss Medical".
  provider_name       TEXT,
  -- Plano específico (UI editável; ClickUp não tem campo equivalente hoje).
  plan                TEXT,
  -- Número do afiliado (ClickUp: "Número ID Afiliado Paciente").
  member_id           TEXT,
  -- Números de emergência da operadora (UI editável; ClickUp não tem campo equivalente).
  emergency_numbers   TEXT[]       NOT NULL DEFAULT '{}',

  -- Origem do registro. 'clickup' = sync; 'manual' = editado via app.
  source              TEXT         NOT NULL DEFAULT 'clickup',

  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT patient_health_insurance_patient_unique UNIQUE (patient_id),
  CONSTRAINT patient_health_insurance_source_check
    CHECK (source IN ('clickup', 'manual'))
);

COMMENT ON TABLE patient_health_insurance IS
  'Cobertura médica do paciente. 1:1 com patients. Substitui as colunas legadas em patients (insurance_informed/verified, affiliate_id, health_insurance_name/member_id) — todas marcadas deprecated na mig 185.';

COMMENT ON COLUMN patient_health_insurance.provider_name IS
  'Nome da operadora de saúde. ClickUp: "Cobertura Informada".';
COMMENT ON COLUMN patient_health_insurance.plan IS
  'Plano específico contratado. Editável via app — ClickUp não tem campo equivalente.';
COMMENT ON COLUMN patient_health_insurance.member_id IS
  'Número do afiliado / credencial. ClickUp: "Número ID Afiliado Paciente".';
COMMENT ON COLUMN patient_health_insurance.emergency_numbers IS
  'Telefones de emergência da operadora. Editável via app.';
COMMENT ON COLUMN patient_health_insurance.source IS
  'Origem do registro: clickup (sync automático) ou manual (criado/editado pelo usuário).';

-- ── 2. Backfill ──────────────────────────────────────────────────────────────
-- Só member_id tem dados em prod. Sanitiza string literal "null" (bug de
-- serialização do sync atual) tratando como SQL NULL real.

INSERT INTO patient_health_insurance (patient_id, member_id, source)
SELECT
  p.id,
  NULLIF(TRIM(p.health_insurance_member_id), 'null'),
  'clickup'
FROM patients p
WHERE p.deleted_at IS NULL
  AND p.health_insurance_member_id IS NOT NULL
  AND NULLIF(TRIM(p.health_insurance_member_id), 'null') IS NOT NULL
ON CONFLICT (patient_id) DO NOTHING;

COMMIT;
