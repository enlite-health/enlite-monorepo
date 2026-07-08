-- 238_worker_case_memory.sql
--
-- Camada A (dossiê da Luz): memória por-worker do RELACIONAMENTO — o que a Luz já
-- tentou, o que falta pro cadastro, onde a pessoa travou, o que prometeu. É
-- distinto do estado FACTUAL do cadastro (esse vive nas colunas de `workers`):
-- aqui mora a "relação", pra a Luz retomar sem repetir e agir como recrutadora.
-- 1 linha por worker. Consumido via MCP (worker.caseMemory.get/put) pelo triage.
-- Ver triage-service/docs/FEATURE_LUZ_CASE_MEMORY.md.
--
-- Aditiva: tabela nova, nenhum backfill. Payload pequeno e bounded (o servidor
-- aplica FIFO/caps ao gravar — ver worker/domain/CaseMemory.ts).

CREATE TABLE IF NOT EXISTS worker_case_memory (
  worker_id  UUID PRIMARY KEY REFERENCES workers(id) ON DELETE CASCADE,
  data       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
