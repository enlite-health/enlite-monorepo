-- 235_rekey_contact_notes_to_worker_vacancy.sql
--
-- Feature: coluna BLOQUEADO com comentários que sobrevivem à promoção.
--
-- Problema: wja_contact_notes era chaveada por worker_job_application_id (WJA).
-- Um card BLOQUEADO (worker_blocked_applications) NÃO tem WJA — só ganha uma
-- quando é promovido (PromoteBlockedApplicationsUseCase). Notas escritas
-- enquanto o card estava bloqueado não tinham onde ser penduradas.
--
-- Solução: re-chavear para o par estável (worker_id, job_posting_id), que:
--   - é UNIQUE em worker_job_applications (unique_worker_job_application,
--     migration 011)
--   - é UNIQUE em worker_blocked_applications (uq_worker_blocked_applications_
--     worker_job, migration 209)
--   - NÃO muda na promoção BLOQUEADO→INICIADO (mesmo worker_id/job_posting_id
--     antes e depois) — as notas seguem o candidato sem precisar de
--     copy-on-promote.
--
-- Aditiva: worker_job_application_id vira opcional (nullable), mantida para
-- rastreabilidade histórica e para não quebrar leituras antigas. Novo código
-- passa a filtrar por (worker_id, job_posting_id).
--
-- SEM FK nas colunas novas — mesma filosofia da migration 209 (comentário
-- "Isolamento: esta tabela NÃO usa FK para workers nem job_postings para
-- tolerar workers mesclados (merged_into_id) e vagas removidas via
-- soft-delete (archived_at)"). Notas de um candidato mesclado ou de uma vaga
-- soft-deletada continuam legíveis/auditáveis mesmo sem a linha "viva" do
-- outro lado.

ALTER TABLE wja_contact_notes
  ADD COLUMN IF NOT EXISTS worker_id UUID,
  ADD COLUMN IF NOT EXISTS job_posting_id UUID;

ALTER TABLE wja_contact_notes
  ALTER COLUMN worker_job_application_id DROP NOT NULL;

-- Backfill: deriva worker_id/job_posting_id da WJA associada (todas as notas
-- existentes até aqui têm worker_job_application_id preenchido).
UPDATE wja_contact_notes cn
SET worker_id = wja.worker_id,
    job_posting_id = wja.job_posting_id
FROM worker_job_applications wja
WHERE cn.worker_job_application_id = wja.id
  AND cn.worker_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_wja_contact_notes_worker_vacancy
  ON wja_contact_notes(worker_id, job_posting_id, created_at DESC);

COMMENT ON COLUMN wja_contact_notes.worker_id IS
  'Par estável (worker_id, job_posting_id) — chave canônica pós migration 235. '
  'Sobrevive à promoção BLOQUEADO→INICIADO (PromoteBlockedApplicationsUseCase), '
  'diferente de worker_job_application_id que só existe depois da promoção.';

COMMENT ON COLUMN wja_contact_notes.job_posting_id IS
  'Ver comentário de wja_contact_notes.worker_id.';

COMMENT ON COLUMN wja_contact_notes.worker_job_application_id IS
  'Legado (migration 204). Nullable desde a migration 235 — notas de cards '
  'BLOQUEADO (sem WJA) gravam NULL aqui. Resolvido best-effort no insert '
  '(subquery) quando já existe WJA para o par; mantido só para '
  'rastreabilidade histórica, não é mais usado para leitura.';

-- Validação esperada pós-backfill: 0 linhas com worker_id NULL (só ficaria
-- NULL uma nota cuja WJA associada não existe mais — não deveria ocorrer,
-- pois worker_job_application_id tem FK ON DELETE CASCADE para
-- worker_job_applications, então a nota é removida junto com a WJA).
-- SELECT COUNT(*) FROM wja_contact_notes WHERE worker_id IS NULL; -- esperado: 0
