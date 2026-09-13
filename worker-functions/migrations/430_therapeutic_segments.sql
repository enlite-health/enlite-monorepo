-- 430 — `therapeutic_segments`: catálogo dos segmentos da Ana Care (spec 018, PR-7, US-17, SUP-28).
--
-- Mesmo molde de `therapeutic_specific_objectives`/`therapeutic_activities` (415): tabela GLOBAL,
-- sem `country`, sem PHI por desenho — a guarda contra texto pessoal no rótulo é
-- `containsLikelyPersonalData` no servidor (lex-pr7 C3(a)), aplicada ANTES do INSERT/UPDATE do
-- rótulo (fora desta migration — camada de validação em `therapeuticProjectSchemas.ts`).
--
-- SEM SEED: a lista de segmentos da Ana Care não está no repo (research §3e do plan.md); o seed
-- entra por migration própria quando a lista chegar (PH-6). A tela filtra por `segmentId`
-- (`GET /therapeutic-catalogs/:kind?segmentId=`) e, com a tabela vazia, o filtro fica escondido
-- (nenhum segmento cadastrado = nenhuma opção a filtrar).
--
-- `segmentId/segmentLabel` no snapshot do projeto terapêutico saem só com `patient_clinical:read`
-- (lex-pr7 C3(b)) — regra da CAMADA DE LEITURA (`application/therapeuticProjectAccess.ts`), fora
-- desta migration.
--
-- Fora do `enlite_mcp_ro` até a guarda de rótulo ter teste que prova (molde C18 da 415) — REVOKE
-- em `scripts/create-mcp-ro-role.sql`, MESMO commit.
--
-- Rollback: `ALTER TABLE ... DROP COLUMN segment_id` nos dois catálogos, `DROP TABLE therapeutic_segments`
-- — nasce vazia nesta árvore, nenhuma versão referencia `segment_id` ainda.

CREATE TABLE IF NOT EXISTS therapeutic_segments (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  label          TEXT         NOT NULL,
  sort_order     INT          NOT NULL DEFAULT 0,
  active         BOOLEAN      NOT NULL DEFAULT true,
  deactivated_at TIMESTAMPTZ  NULL,
  created_by     VARCHAR(128) NOT NULL,
  updated_by     VARCHAR(128) NOT NULL,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT therapeutic_segments_label_len CHECK (length(btrim(label)) BETWEEN 1 AND 200),
  CONSTRAINT therapeutic_segments_active_coerente CHECK (
    (active AND deactivated_at IS NULL) OR (NOT active AND deactivated_at IS NOT NULL)
  )
);

-- Rótulo único entre os ATIVOS (case-insensitive) — mesmo molde 415.
CREATE UNIQUE INDEX IF NOT EXISTS uq_therapeutic_segments_label_ativo ON therapeutic_segments (lower(btrim(label))) WHERE active;
CREATE INDEX IF NOT EXISTS idx_therapeutic_segments_ordem ON therapeutic_segments (active, sort_order);

COMMENT ON TABLE therapeutic_segments IS
  'Catálogo global (sem país, sem PHI) dos segmentos da Ana Care (spec 018, PR-7, US-17, SUP-28). '
  'Sem seed nesta migration (PH-6). Baixa = active=false + deactivated_at, nunca DELETE. Rótulo passa '
  'pela guarda de dado pessoal no servidor (lex-pr7 C3(a)).';

-- Filtro (não recorte do que pode ser gravado — molde #REQ-16): objetivo/atividade PODEM apontar
-- para um segmento, mas continuam existindo sem ele.
ALTER TABLE therapeutic_specific_objectives ADD COLUMN IF NOT EXISTS segment_id UUID NULL REFERENCES therapeutic_segments(id);
ALTER TABLE therapeutic_activities          ADD COLUMN IF NOT EXISTS segment_id UUID NULL REFERENCES therapeutic_segments(id);

CREATE INDEX IF NOT EXISTS idx_therapeutic_specific_objectives_segment ON therapeutic_specific_objectives (segment_id);
CREATE INDEX IF NOT EXISTS idx_therapeutic_activities_segment ON therapeutic_activities (segment_id);

COMMENT ON COLUMN therapeutic_specific_objectives.segment_id IS
  'Filtro por segmento da Ana Care (430) — NULL permitido, não recorta o que pode ser gravado (#REQ-16).';
COMMENT ON COLUMN therapeutic_activities.segment_id IS
  'Filtro por segmento da Ana Care (430) — NULL permitido, não recorta o que pode ser gravado (#REQ-16).';

-- GRANT explícito (stage roda como app_runtime; sem ALTER DEFAULT PRIVILEGES — molde 419/422).
GRANT SELECT, INSERT, UPDATE ON therapeutic_segments TO app_runtime, app_system;
