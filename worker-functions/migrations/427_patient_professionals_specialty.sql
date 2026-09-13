-- 427 — especialidade e autoria na equipe tratante (spec 018, PR-5, US-11; `lex` #5 CONDICIONADO).
--
-- `patient_professionals` (038/068/071/420) ganha `specialty` (enum fechado, SUP-38) e a UNIQUE
-- `(id, patient_id)` que o PR-7 (429) vai usar como alvo de FK composta da ligação
-- versão→profissional. `source`/`created_by`/`active`/`deactivated_*` já existem (038 default
-- 'clickup'; 420). Linha nova do painel grava `source='admin_manual'`.
--
-- ── `created_by` obrigatório só para linha do painel (premissa 1 desta execução) ────────────────
-- O plano/data-model não resolve a divergência entre "toda linha tem created_by" (regra 9 do
-- molde) e o fato de as ~3000 linhas herdadas do ClickUp (038/061) nunca terem tido autor. Decisão
-- fail-closed: linha NOVA do painel (`source <> 'clickup'`) SEMPRE tem `created_by`; linha legada
-- do ClickUp pode ficar NULL. Mesmo molde do CHECK que o INSERT do painel (`AdminPatientContactRowsController`)
-- já teria de cumprir de qualquer forma (o controller lança se `actorUid` faltar — lex C6).
--
-- Rollback: DROP da UNIQUE, DROP do CHECK, DROP da coluna `specialty`.

ALTER TABLE patient_professionals ADD COLUMN IF NOT EXISTS specialty TEXT NULL;   -- NULL = legado sem especialidade

ALTER TABLE patient_professionals DROP CONSTRAINT IF EXISTS pp_specialty_check;
ALTER TABLE patient_professionals ADD CONSTRAINT pp_specialty_check CHECK (specialty IS NULL OR specialty IN (
  'PHYSICIAN','PSYCHIATRIST','NEUROLOGIST','PEDIATRICIAN','PSYCHOLOGIST','PHYSIOTHERAPIST','OCCUPATIONAL_THERAPIST',
  'SPEECH_THERAPIST','NUTRITIONIST','NURSE','SOCIAL_WORKER','OTHER'));

-- Premissa 4: `is_team = true` é a entrada especial "equipe multidisciplinar" (038) — não é UM
-- profissional, então não tem especialidade própria.
ALTER TABLE patient_professionals DROP CONSTRAINT IF EXISTS pp_team_sem_especialidade;
ALTER TABLE patient_professionals ADD CONSTRAINT pp_team_sem_especialidade
  CHECK (NOT is_team OR specialty IS NULL);

-- Premissa 1: autoria obrigatória só para a linha nova do painel — legado do ClickUp fica NULL.
ALTER TABLE patient_professionals DROP CONSTRAINT IF EXISTS pp_created_by_obrigatorio_admin_manual;
ALTER TABLE patient_professionals ADD CONSTRAINT pp_created_by_obrigatorio_admin_manual
  CHECK (source <> 'admin_manual' OR created_by IS NOT NULL);

-- Alvo da FK composta que o PR-7 (429) usa para `patient_therapeutic_project_contacts.professional_id`.
ALTER TABLE patient_professionals DROP CONSTRAINT IF EXISTS pp_id_patient_uq;
ALTER TABLE patient_professionals ADD CONSTRAINT pp_id_patient_uq UNIQUE (id, patient_id);

-- GRANT explícito: a tabela nasceu (038) sob o owner (`enlite_app`); a escrita por linha do PR-5
-- passa a rodar sob `app_runtime` (staff) e `app_system` (jobs/sync ClickUp) — mesmo molde 419/410.
GRANT SELECT, INSERT, UPDATE ON patient_professionals TO app_runtime, app_system;

-- ⚠️ O REVOKE do `enlite_mcp_ro` NÃO mora aqui: a role é criada/mantida por `scripts/create-mcp-ro-
-- role.sql` (fora de `migrations/`, molde 312/416/417/418 — "sem revoke [na migration], e é
-- deliberado": a role pode não existir ainda quando só as migrations rodam, ex.: `run-migrations-
-- docker.js` num banco novo). `patient_professionals` foi adicionada ao array de tabelas revogadas
-- NO MESMO commit (`scripts/create-mcp-ro-role.sql`, lex C5/C1 — `name`/`specialty` em claro e o
-- vínculo profissional↔paciente são PHI; `phone_encrypted`/`email_encrypted` já eram opacos, mas a
-- tabela toda sai da lista positiva de qualquer forma). Prova: `tests/e2e/mcp-ro-role.e2e.test.ts`.

COMMENT ON COLUMN patient_professionals.specialty IS
  'Especialidade do profissional tratante (enum fechado, SUP-38). NULL = legado sem especialidade '
  'ou is_team=true (equipe multidisciplinar, sem especialidade própria). Dado de saúde do paciente '
  '(lex 12/09 CONDICIONADO): sai só com patient_care_team:read, nunca no MCP/GBrain.';
