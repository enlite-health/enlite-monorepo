-- 586 — Catálogo terapêutico por CID-11 e serviço (spec 091, F1, §9.2).
--
-- O catálogo de objetivos e atividades passa a ter dono: objetivo → (serviço contratado, categorias CID-11 de 4
-- caracteres); atividade → objetivo (+ categorias, sempre um subconjunto das do objetivo). A planilha entra na 587
-- (dados); esta migration é só SCHEMA + desativação do catálogo antigo + versão nova do PTI.
--
-- ── Decisões (design.md) ─────────────────────────────────────────────────────
--   DF-1/DF-3  o seed 415 e os segmentos da 430 são DESATIVADOS (active=false, updated_by='migration:586'), nunca apagados:
--              versões antigas do PTI guardam o snapshot, e o rollback reativa pelo marcador updated_by.
--   DD-2       a invariante "categoria da atividade ⊆ categorias do objetivo" é FK COMPOSTA, não trigger: vale em todo caminho
--              de escrita (carga, tela, SQL à mão). `therapeutic_activity_icd_categories.objective_id` NÃO é segundo dono: a FK
--              (activity_id, objective_id) com ON UPDATE CASCADE o obriga a ser igual ao da atividade.
--   DD-3       a chave natural troca o índice por rótulo; os nomes novos TERMINAM em `_label_ativo` para o 409 existente
--              (`isLabelUnique`) continuar reconhecendo.
--   DD-7       formato exclusivo do PTI no banco: ou `diagnosis_plans IS NULL` + listas planas ≥ 1 (antigo), ou plano por
--              diagnóstico + listas planas `[]` (novo). `[]` nas planas nunca significa "sem objetivo".
--   DD-15      item ATIVO exige o dono novo (CHECK); reativar item antigo sem dono dá 23514.
--
-- Os vínculos são GRANT SELECT, INSERT, DELETE (sem UPDATE explícito). O DEFAULT PRIVILEGES da 269 ainda concede UPDATE em
-- tabela nova ao role que roda a migration; esta migration não o revoga (SQL do §9.2 é literal).
--
-- Aditiva exceto pelos DROP INDEX/DROP CONSTRAINT dos nomes substituídos (todos IF EXISTS). O runner envolve em transação.
-- Rollback (antes do merge): revert do commit. Depois: migration nova que reativa `updated_by='migration:586'` e desativa
-- `created_by='seed:587'`; vínculos e colunas ficam (aditivo).

-- ── 1. Colunas novas (DF-2) ──────────────────────────────────────────────────
ALTER TABLE therapeutic_specific_objectives ADD COLUMN IF NOT EXISTS service_code TEXT NULL REFERENCES service_types(code) ON UPDATE CASCADE;
ALTER TABLE therapeutic_activities ADD COLUMN IF NOT EXISTS objective_id UUID NULL REFERENCES therapeutic_specific_objectives(id);
ALTER TABLE therapeutic_activities ADD COLUMN IF NOT EXISTS suggested_frequency TEXT NULL;

ALTER TABLE therapeutic_activities DROP CONSTRAINT IF EXISTS therapeutic_activities_suggested_frequency_len;
ALTER TABLE therapeutic_activities ADD CONSTRAINT therapeutic_activities_suggested_frequency_len
  CHECK (suggested_frequency IS NULL OR length(btrim(suggested_frequency)) BETWEEN 1 AND 100);

-- ── 2. Desativar o catálogo atual e os segmentos (DF-1, DF-3) ────────────────
UPDATE therapeutic_specific_objectives
   SET active = false, deactivated_at = COALESCE(deactivated_at, NOW()), updated_by = 'migration:586', updated_at = NOW()
 WHERE active AND service_code IS NULL;
UPDATE therapeutic_activities
   SET active = false, deactivated_at = COALESCE(deactivated_at, NOW()), updated_by = 'migration:586', updated_at = NOW()
 WHERE active AND objective_id IS NULL;
UPDATE therapeutic_segments
   SET active = false, deactivated_at = COALESCE(deactivated_at, NOW()), updated_by = 'migration:586', updated_at = NOW()
 WHERE active;

-- ── 3. Item ativo exige dono (DD-15) ─────────────────────────────────────────
ALTER TABLE therapeutic_specific_objectives DROP CONSTRAINT IF EXISTS therapeutic_specific_objectives_ativo_tem_servico;
ALTER TABLE therapeutic_specific_objectives ADD CONSTRAINT therapeutic_specific_objectives_ativo_tem_servico
  CHECK (NOT active OR service_code IS NOT NULL);
ALTER TABLE therapeutic_activities DROP CONSTRAINT IF EXISTS therapeutic_activities_ativa_tem_objetivo;
ALTER TABLE therapeutic_activities ADD CONSTRAINT therapeutic_activities_ativa_tem_objetivo
  CHECK (NOT active OR objective_id IS NOT NULL);

-- ── 4. Chave natural (DD-3) ──────────────────────────────────────────────────
DROP INDEX IF EXISTS uq_therapeutic_specific_objectives_label_ativo;
CREATE UNIQUE INDEX IF NOT EXISTS uq_therapeutic_specific_objectives_servico_label_ativo
  ON therapeutic_specific_objectives (service_code, lower(btrim(label)), lower(btrim(COALESCE(description, '')))) WHERE active;
DROP INDEX IF EXISTS uq_therapeutic_activities_label_ativo;
CREATE UNIQUE INDEX IF NOT EXISTS uq_therapeutic_activities_objetivo_label_ativo
  ON therapeutic_activities (objective_id, lower(btrim(label)), lower(btrim(COALESCE(description, '')))) WHERE active;
-- alvo da FK composta do vínculo da atividade (DD-2)
CREATE UNIQUE INDEX IF NOT EXISTS uq_therapeutic_activities_id_objetivo ON therapeutic_activities (id, objective_id);
CREATE INDEX IF NOT EXISTS idx_therapeutic_activities_objective ON therapeutic_activities (objective_id);

-- ── 5. Vínculos (DF-2, DD-2, DD-4) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS therapeutic_objective_icd_categories (
  objective_id  UUID         NOT NULL REFERENCES therapeutic_specific_objectives(id),
  category_code TEXT         NOT NULL,
  sort_order    INT          NULL,
  created_by    VARCHAR(128) NOT NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT therapeutic_objective_icd_categories_pkey PRIMARY KEY (objective_id, category_code),
  CONSTRAINT therapeutic_objective_icd_categories_code_formato CHECK (category_code ~ '^[0-9A-Z]{4}$')
);
CREATE INDEX IF NOT EXISTS idx_therapeutic_objective_icd_categories_code ON therapeutic_objective_icd_categories (category_code);

CREATE TABLE IF NOT EXISTS therapeutic_activity_icd_categories (
  activity_id   UUID         NOT NULL,
  objective_id  UUID         NOT NULL,
  category_code TEXT         NOT NULL,
  sort_order    INT          NULL,
  created_by    VARCHAR(128) NOT NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT therapeutic_activity_icd_categories_pkey PRIMARY KEY (activity_id, category_code),
  CONSTRAINT therapeutic_activity_icd_categories_code_formato CHECK (category_code ~ '^[0-9A-Z]{4}$'),
  CONSTRAINT therapeutic_activity_icd_categories_atividade_fk FOREIGN KEY (activity_id, objective_id)
    REFERENCES therapeutic_activities (id, objective_id) ON UPDATE CASCADE,
  CONSTRAINT therapeutic_activity_icd_categories_dentro_do_objetivo_fk FOREIGN KEY (objective_id, category_code)
    REFERENCES therapeutic_objective_icd_categories (objective_id, category_code) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_therapeutic_activity_icd_categories_code ON therapeutic_activity_icd_categories (category_code);
CREATE INDEX IF NOT EXISTS idx_therapeutic_activity_icd_categories_obj_code ON therapeutic_activity_icd_categories (objective_id, category_code);

GRANT SELECT, INSERT, DELETE ON therapeutic_objective_icd_categories, therapeutic_activity_icd_categories TO app_runtime, app_system;

-- DD-11: o JOIN do vínculo com o catálogo CID-11 filtra por (release, code)
CREATE INDEX IF NOT EXISTS idx_icd_entities_release_code ON terminology.icd_entities (release, code);

COMMENT ON COLUMN therapeutic_specific_objectives.segment_id IS 'DESCONTINUADA (091): não ler nem escrever';
COMMENT ON COLUMN therapeutic_activities.segment_id IS 'DESCONTINUADA (091): não ler nem escrever';
COMMENT ON COLUMN therapeutic_activity_icd_categories.objective_id IS
  'Propagação de therapeutic_activities.objective_id, mantida só por FK composta (ON UPDATE CASCADE). Nunca escrever de forma independente.';
COMMENT ON COLUMN therapeutic_specific_objectives.sort_order IS
  'Legado 415, sem uso no catálogo por CID; a ordem por categoria mora no vínculo (091)';
COMMENT ON COLUMN therapeutic_activities.sort_order IS
  'Legado 415, sem uso no catálogo por CID; a ordem por categoria mora no vínculo (091)';
COMMENT ON COLUMN therapeutic_activities.suggested_frequency IS
  'Frequência sugerida, texto livre (091). NULL = sem frequência sugerida.';
COMMENT ON COLUMN therapeutic_specific_objectives.service_code IS
  'Serviço contratado dono do objetivo (service_types.code) (091). Item ativo exige service_code (DD-15).';
COMMENT ON COLUMN therapeutic_activities.objective_id IS
  'Objetivo específico dono da atividade (091). Atividade ativa exige objective_id (DD-15).';
COMMENT ON TABLE therapeutic_objective_icd_categories IS
  'Vínculo objetivo ↔ categoria CID-11 (091). category_code = código da categoria CID-11, 4 caracteres, sem release. Sem PHI. Catálogo global.';
COMMENT ON TABLE therapeutic_activity_icd_categories IS
  'Vínculo atividade ↔ categoria CID-11 (091); a categoria tem de existir no vínculo do objetivo da atividade (FK composta, DD-2). Sem PHI. Catálogo global.';
COMMENT ON COLUMN therapeutic_objective_icd_categories.category_code IS 'Código da categoria CID-11, 4 caracteres, sem release.';
COMMENT ON COLUMN therapeutic_activity_icd_categories.category_code IS 'Código da categoria CID-11, 4 caracteres, sem release.';

-- ── 6. Versão do PTI (DF-7, DD-5, DD-7) ──────────────────────────────────────
ALTER TABLE patient_therapeutic_projects ADD COLUMN IF NOT EXISTS diagnosis_plans JSONB NULL;
ALTER TABLE patient_therapeutic_projects DROP CONSTRAINT IF EXISTS ptp_specific_objectives_lista;
ALTER TABLE patient_therapeutic_projects DROP CONSTRAINT IF EXISTS ptp_activities_lista;
ALTER TABLE patient_therapeutic_projects DROP CONSTRAINT IF EXISTS ptp_formato_objetivos;
ALTER TABLE patient_therapeutic_projects ADD CONSTRAINT ptp_formato_objetivos CHECK (
  jsonb_typeof(specific_objectives) = 'array' AND jsonb_typeof(activities) = 'array' AND (
    (diagnosis_plans IS NULL AND jsonb_array_length(specific_objectives) >= 1 AND jsonb_array_length(activities) >= 1)
    OR (diagnosis_plans IS NOT NULL AND jsonb_typeof(diagnosis_plans) = 'array'
        AND jsonb_array_length(diagnosis_plans) = jsonb_array_length(diagnoses)
        AND jsonb_array_length(specific_objectives) = 0 AND jsonb_array_length(activities) = 0)));

-- Forma dos blocos no banco: cada elemento é objeto com diagnosisUri (string), categoryCode (string ou null), objectives (array)
-- e activities (array), e plans[i].diagnosisUri = diagnoses[i]->>'uri' (mesma ordem de `diagnoses`). `IS NOT TRUE` pega o NULL
-- de chave ausente (um NOT(NULL) no WHERE deixaria o elemento malformado passar).
CREATE OR REPLACE FUNCTION fn_ptp_diagnosis_plans_ok(plans jsonb, diagnoses jsonb)
RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_typeof(plans) = 'array'
     AND jsonb_typeof(diagnoses) = 'array'
     AND jsonb_array_length(plans) = jsonb_array_length(diagnoses)
     AND NOT EXISTS (
       SELECT 1
         FROM jsonb_array_elements(plans) WITH ORDINALITY AS p(elem, pos)
        WHERE (
          jsonb_typeof(p.elem) = 'object'
          AND jsonb_typeof(p.elem -> 'diagnosisUri') = 'string'
          AND (p.elem ? 'categoryCode')
          AND jsonb_typeof(p.elem -> 'categoryCode') IN ('string', 'null')
          AND jsonb_typeof(p.elem -> 'objectives') = 'array'
          AND jsonb_typeof(p.elem -> 'activities') = 'array'
          AND (p.elem ->> 'diagnosisUri') = (diagnoses -> ((p.pos - 1)::int) ->> 'uri')
        ) IS NOT TRUE
     )
$$;

ALTER TABLE patient_therapeutic_projects DROP CONSTRAINT IF EXISTS ptp_diagnosis_plans_forma;
ALTER TABLE patient_therapeutic_projects ADD CONSTRAINT ptp_diagnosis_plans_forma CHECK (
  diagnosis_plans IS NULL OR fn_ptp_diagnosis_plans_ok(diagnosis_plans, diagnoses));

-- Trigger de imutabilidade: DENYLIST de colunas (416, 417, 496). Coluna nova NÃO fica protegida sozinha — o corpo abaixo é o da
-- 496 inteiro + a linha de `diagnosis_plans` (única nova).
CREATE OR REPLACE FUNCTION fn_patient_therapeutic_projects_imutavel()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM patients p WHERE p.id = OLD.patient_id) THEN
      RAISE EXCEPTION 'ptp_imutavel: versão do projeto terapêutico não se apaga (lex C5)'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
     OR NEW.major IS DISTINCT FROM OLD.major
     OR NEW.minor IS DISTINCT FROM OLD.minor
     OR NEW.edited_from_version_id IS DISTINCT FROM OLD.edited_from_version_id
     OR NEW.contracted_service_id IS DISTINCT FROM OLD.contracted_service_id
     OR NEW.modality IS DISTINCT FROM OLD.modality
     OR NEW.contracted_service_code IS DISTINCT FROM OLD.contracted_service_code
     OR NEW.diagnoses IS DISTINCT FROM OLD.diagnoses
     OR NEW.clinical_context IS DISTINCT FROM OLD.clinical_context
     OR NEW.general_objective IS DISTINCT FROM OLD.general_objective
     OR NEW.specific_objectives IS DISTINCT FROM OLD.specific_objectives
     OR NEW.activities IS DISTINCT FROM OLD.activities
     OR NEW.pathology_types IS DISTINCT FROM OLD.pathology_types
     OR NEW.segment IS DISTINCT FROM OLD.segment
     OR NEW.diagnosis_plans IS DISTINCT FROM OLD.diagnosis_plans
     OR NEW.start_date IS DISTINCT FROM OLD.start_date
     OR NEW.end_date IS DISTINCT FROM OLD.end_date
     OR NEW.country IS DISTINCT FROM OLD.country
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'ptp_imutavel: versão do projeto terapêutico não se edita — crie a minor seguinte (lex C5)'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.annulled_at IS NOT NULL AND (
       NEW.annulled_at IS DISTINCT FROM OLD.annulled_at
    OR NEW.annulled_by IS DISTINCT FROM OLD.annulled_by
    OR NEW.annul_reason IS DISTINCT FROM OLD.annul_reason
  ) THEN
    RAISE EXCEPTION 'ptp_imutavel: anulação não se desfaz nem se reescreve' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON COLUMN patient_therapeutic_projects.diagnosis_plans IS
  'Plano por diagnóstico (spec 091): [{diagnosisUri, categoryCode, objectives:[{id,label,description?}], activities:[{id,label,description?,objectiveId,suggestedFrequency?}]}]; NULL = versão no formato plano anterior à 586. categoryCode é fato congelado (categoria sob a qual o catálogo foi consultado, no release da época): não recalcular. Dado clínico: redigido sem patient_clinical:read.';
