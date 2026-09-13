-- 421 — relação ampliada de `patient_responsibles.relationship` (spec 018, PR-2, US-13, SUP-16).
--
-- Amplia a lista fechada de parentesco (CHECK) para cobrir os relatos reais da ficha que hoje
-- caem em OTHER sem distinção (SUP-16). Os 9 valores originais (migration 139) são preservados —
-- é ADITIVA, zero linha migrada. A mesma lista vive em `Relationship.ts` (back) e
-- `RELATIONSHIP_CODES` de `patientEnums.ts:40` (front); o teste de contrato
-- `relationshipParity.contract.test.ts` lê o CHECK desta migration (a mais recente que o define)
-- e falha se qualquer um dos três (banco/back/front) divergir.
--
-- Rollback: recriar o CHECK só com os 9 originais (139_…sql) — sem apagar linha, porque nenhum
-- valor novo tem uso ainda no momento desta migration.
ALTER TABLE patient_responsibles DROP CONSTRAINT IF EXISTS patient_responsibles_relationship_check;
ALTER TABLE patient_responsibles ADD CONSTRAINT patient_responsibles_relationship_check CHECK (relationship IS NULL OR relationship IN (
  'CHILD','PARENT','SIBLING','NEPHEW','GRANDCHILD','GUARDIAN','FRIEND','PARTNER','OTHER',
  'GRANDPARENT','UNCLE_AUNT','COUSIN','IN_LAW','STEP_RELATIVE','RESPONSIBLE_PERSON'
));

COMMENT ON COLUMN patient_responsibles.relationship IS
  'Parentesco do responsável com o paciente (CHECK). Ampliado na 421 (SUP-16): +GRANDPARENT, '
  'UNCLE_AUNT, COUSIN, IN_LAW, STEP_RELATIVE, RESPONSIBLE_PERSON. Lista fechada — espelhar em '
  'Relationship.ts e patientEnums.ts:RELATIONSHIP_CODES (relationshipParity.contract.test.ts).';
