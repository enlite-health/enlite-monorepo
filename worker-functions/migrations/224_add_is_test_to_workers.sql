-- Migration 224: flag de conta de teste em workers.
--
-- CONTEXTO: a operação precisa marcar workers que são contas de teste (QA,
-- demos, smoke) para distingui-los de prestadores reais em listagens, matching
-- e métricas. A marcação é controlada exclusivamente por admin via
-- PATCH /api/admin/workers/:id/test-flag.
--
-- DECISÃO: coluna booleana simples, NOT NULL DEFAULT false. Não é PII, não
-- precisa de encriptação nem blind index (não é filtrável hoje — é só um flag
-- de exibição/segmentação futura).
--
-- Aditiva e idempotente: ADD COLUMN IF NOT EXISTS.

ALTER TABLE workers
  ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false;
