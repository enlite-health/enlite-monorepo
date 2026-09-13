-- 424 — taxonomia dos contatos de emergência da COBERTURA (spec 018, PR-2, US-14, SUP-17).
--
-- Contagem por `kind` ANTES desta migration, medida via MCP read-only (mcp__claude_ai_Worker_Functions__db_query_readonly)
-- em 12/09/2026, direto na produção (banco enlite_ar):
--
--   SELECT kind, count(*) FROM patient_coverage_emergency_contacts GROUP BY kind;
--   → ERRO: relation "patient_coverage_emergency_contacts" does not exist
--
-- Motivo (já previsto em data-model.md §424 e na Emenda 12/09-B do registro de operações): a
-- migration 417, que CRIA esta tabela, está em `origin/stage` mas NÃO está em `origin/main`
-- (conferido: `git ls-tree origin/main worker-functions/migrations/` vai só até 332, e
-- `git ls-tree origin/stage ...` já tem 417-420). Em produção a tabela chega VAZIA no mesmo trem
-- desta 424 — o UPDATE abaixo é NO-OP lá, e o risco nomeado no SUP-17 (ambulância privada
-- gravada como AMBULANCE virando "do plano" por engano) não se materializa em produção porque
-- não há nenhuma linha legada para reclassificar.
--
-- PREMISSA ADOTADA (SUP-17, sem resposta humana, já declarada na Emenda 12/09-B): o UPDATE roda
-- mesmo assim porque a `stage` TEM massa sintética em `patient_coverage_emergency_contacts`
-- (417 já mergeada lá) e o objetivo desta migration é a taxonomia nova valer também na `stage` e
-- em qualquer banco de dev/CI que já tenha rodado a 417. A contagem por kind ali, medida e colada
-- pelo autor de cada ambiente antes de aplicar, é o controle equivalente — comando:
--
--   SELECT kind, count(*) FROM patient_coverage_emergency_contacts GROUP BY kind;   -- ANTES
--   -- aplicar a migration --
--   SELECT kind, count(*) FROM patient_coverage_emergency_contacts GROUP BY kind;   -- DEPOIS
--
-- Rollback: DROP CONSTRAINT pcec_kind_check e recriar com os 3 valores antigos
-- ('DIRECT_PROFESSIONAL','AMBULANCE','EMERGENCY_CENTER') — a linha migrada para
-- INSURANCE_EMERGENCY NÃO volta a AMBULANCE/EMERGENCY_CENTER automaticamente (perda de
-- informação já aceita nesta migration; se algum ambiente precisar desfazer de fato, o dump
-- ANTES colado no PR é o único jeito de restaurar o valor original linha a linha).
ALTER TABLE patient_coverage_emergency_contacts DROP CONSTRAINT IF EXISTS pcec_kind_check;

UPDATE patient_coverage_emergency_contacts
   SET kind = 'INSURANCE_EMERGENCY'
 WHERE kind IN ('AMBULANCE', 'EMERGENCY_CENTER');

ALTER TABLE patient_coverage_emergency_contacts ADD CONSTRAINT pcec_kind_check
  CHECK (kind IN ('DIRECT_PROFESSIONAL', 'PUBLIC_EMERGENCY_SERVICE', 'PRIVATE_AMBULANCE', 'INSURANCE_EMERGENCY'));

COMMENT ON COLUMN patient_coverage_emergency_contacts.kind IS
  'Tipo do contato de emergência da cobertura médica (CHECK). Ampliado na 424 (SUP-14/US-14): '
  'DIRECT_PROFESSIONAL | PUBLIC_EMERGENCY_SERVICE | PRIVATE_AMBULANCE | INSURANCE_EMERGENCY. '
  'Legado AMBULANCE/EMERGENCY_CENTER migrado para INSURANCE_EMERGENCY (SUP-17, premissa sem '
  'resposta humana — ver Emenda 12/09-B do registro de operações). Espelhar em '
  'COVERAGE_EMERGENCY_CONTACT_KINDS (PatientCoverageEmergencyContact.ts:10) e no front no mesmo commit.';
