-- 496 — Spec 030 (F2, FR-004, lex C1): o SEGMENTO (Ana Care) vira campo da versão imutável do
-- Projeto Terapêutico, como snapshot `{id,label}` congelado no INSERT (o rótulo é resolvido no
-- servidor, a partir do catálogo ATIVO `therapeutic_segments`; o cliente nunca manda `label`).
--
-- `NULL` significa SÓ "versão anterior à 030" (imutável: não se retroalimenta), como `modality`
-- antes da 417; o zod EXIGE `segmentId` em versão nova. Dado CLÍNICO (lex C2): a projeção
-- (`therapeuticProjectAccess.ts`) devolve `null` sem `patient_clinical:read`.
--
-- O trigger de imutabilidade é uma DENYLIST explícita de colunas (416:141-157; recriada na 417 para
-- `modality`) — coluna nova NÃO fica protegida sozinha. Recriado abaixo = a função da 417 inteira
-- + o teste de `segment` (única linha nova).
--
-- Aditiva e idempotente; o runner já envolve em transação; nenhuma coluna/tabela é removida
-- (o único DROP é `DROP CONSTRAINT IF EXISTS` do CHECK, para reaplicar, como a 417).
-- Rollback: remover a constraint ptp_segment_check e a coluna segment;
--           e recriar a função da 417 (nasce NULL em toda linha — nada se perde antes do 1º uso).
ALTER TABLE patient_therapeutic_projects ADD COLUMN IF NOT EXISTS segment JSONB NULL;
ALTER TABLE patient_therapeutic_projects DROP CONSTRAINT IF EXISTS ptp_segment_check;
ALTER TABLE patient_therapeutic_projects
  ADD CONSTRAINT ptp_segment_check CHECK (
    segment IS NULL OR (jsonb_typeof(segment) = 'object' AND segment ? 'id' AND segment ? 'label')
  );
COMMENT ON COLUMN patient_therapeutic_projects.segment IS
  'Segmento Ana Care congelado na versão ({id,label}, spec 030); NULL só em versão anterior à 496. Dado clínico: redigido sem patient_clinical:read; fora do enlite_mcp_ro.';

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
