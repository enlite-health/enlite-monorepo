-- 425 — gênero declarado e idiomas do PACIENTE (spec 018, PR-3, Emenda 13/09 do registro de
-- operações — `lex` CONDICIONADO #2a/#2b/#2c/#3, D-A #5/#9).
--
-- Duas categorias NOVAS, cifradas com KMS (mesmo molde da 023 em `workers`):
--   (a) gender_encrypted    — gênero declarado. NULL = não perguntado (distinto de
--       PREFER_NOT_TO_SAY, que é resposta explícita de não informar). Enum fechado no
--       aplicativo (Zod), não no banco — a coluna é cifrada, então nenhum CHECK a alcança
--       (mesma razão do comentário em workers.gender_encrypted, migration 023).
--   (b) languages_encrypted — idiomas em que o paciente se comunica. JSON array cifrado como
--       UM ciphertext (mesmo formato de workers.languages_encrypted) — lista fechada ISO
--       pt/es/en (a mesma de `workers.languages`), validada no Zod, não aqui.
--
-- Coleta SEMPRE facultativa (Ley 25.326 art. 7 inc. 1): nenhuma das duas entra no `zod` como
-- obrigatória, no checklist de completude, nem em `patientSectionSchemas` como required.
--
-- Categorias PROIBIDAS (lex #2a, PARE): orientação sexual, origem racial/étnica e religião NÃO
-- ganham coluna aqui nem em nenhuma outra nesta migration.
--
-- Sem `_bidx`: nenhum dos dois campos é filtrável/buscável nesta emenda (lex #2c, L2c-4) — só
-- exibição na ficha, sob `patient_identity:read` (`DETAIL_FIELDS.identity`,
-- patientContainerAccess.ts), nunca em `LIST_FIELDS`.
--
-- REVOKE do `enlite_mcp_ro`: NÃO precisa listar aqui — `scripts/create-mcp-ro-role.sql` (raiz do
-- monorepo) usa lista POSITIVA (REVOKE SELECT ON patients FROM enlite_mcp_ro; GRANT SELECT
-- (<colunas>) ON patients TO enlite_mcp_ro), e coluna nova nasce FORA da lista, logo invisível
-- por padrão (mesmo comentário de lá: "coluna nova em `patients` nasce invisível: NÃO listar").
-- Prova: `grep -n "gender_encrypted\|languages_encrypted" scripts/create-mcp-ro-role.sql` → sem
-- ocorrência (condição 3 do lex satisfeita por AUSÊNCIA da lista positiva, não por REVOKE
-- explícito; `mcp-ro-role.e2e.test.ts` prova isso contra o banco vivo).
--
-- Rollback: DROP COLUMN nas duas — nascem NULL, nenhuma linha pré-existente é afetada.

ALTER TABLE patients ADD COLUMN IF NOT EXISTS gender_encrypted    TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS languages_encrypted TEXT;

COMMENT ON COLUMN patients.gender_encrypted IS
  'Gênero declarado do paciente — KMS encrypted (Emenda 13/09, spec 018 PR-3). Enum fechado no '
  'Zod (FEMALE/MALE/NON_BINARY/OTHER/PREFER_NOT_TO_SAY); NULL = não perguntado, distinto de '
  'PREFER_NOT_TO_SAY. Coleta facultativa (Ley 25.326 art. 7 inc. 1). Nunca propagado a vaga, '
  'matching, Talentum, PDF, MCP, LLM ou GBrain nesta emenda.';

COMMENT ON COLUMN patients.languages_encrypted IS
  'Idiomas em que o paciente se comunica (JSON array cifrado como um ciphertext, mesmo molde de '
  'workers.languages_encrypted) — lista fechada ISO pt/es/en. Coleta facultativa. Nunca '
  'propagado a vaga, matching, Talentum, PDF, MCP, LLM ou GBrain nesta emenda.';
