-- 237_restore_contact_notes_per_candidate.sql
--
-- DECISÃO FINAL de produto: contact notes é PER-CANDIDATO (worker×vaga), NÃO per-vaga.
-- Cada candidato tem sua própria thread de comentários, que segue o card entre
-- colunas (inclusive Bloqueado→Iniciado) e não zera. Isso é o comportamento da
-- migration 235.
--
-- A migration 236 escopou as notas por VAGA (job_posting_id) por engano — renomeou
-- worker_id / worker_job_application_id para *_deprecated_20260707 e trocou o índice
-- por um só-vaga. Esta migration DESFAZ isso: renomeia as colunas de volta e
-- restaura o índice pelo par (worker_id, job_posting_id).
--
-- Aditiva (RENAME + CREATE INDEX, sem DROP) — respeita o guardrail de migração
-- aditiva. O índice só-vaga da 236 (idx_wja_contact_notes_vacancy) fica retido
-- (não é usado pelas queries per-candidato, mas dropá-lo exigiria deprecação em 2
-- fases; custo de mantê-lo é irrelevante).

ALTER TABLE wja_contact_notes
  RENAME COLUMN worker_id_deprecated_20260707 TO worker_id;
ALTER TABLE wja_contact_notes
  RENAME COLUMN worker_job_application_id_deprecated_20260707 TO worker_job_application_id;

CREATE INDEX IF NOT EXISTS idx_wja_contact_notes_worker_vacancy
  ON wja_contact_notes(worker_id, job_posting_id, created_at DESC);

COMMENT ON TABLE wja_contact_notes IS
  'Log append-only de notas manuais de contato por operadora, escopado ao par '
  'candidato×vaga (worker_id, job_posting_id): a mesma thread aparece no card do '
  'candidato em qualquer coluna (inclusive BLOQUEADO) e não zera na promoção '
  'Bloqueado→Iniciado. Migration 235 estabeleceu esse escopo; 236 escopou por vaga '
  'por engano; 237 restaura o escopo per-candidato.';

COMMENT ON COLUMN wja_contact_notes.worker_id IS
  'Parte da chave canônica (worker_id, job_posting_id) — restaurada na migration 237.';

-- ATENÇÃO (data): notas criadas na janela curta em que a 236 esteve em prod
-- (escopo per-vaga) foram inseridas só com job_posting_id, então após o rename
-- ficam com worker_id NULL e não aparecem em nenhum card de candidato (não há como
-- inferir o candidato de uma nota escrita como "da vaga"). Não são deletadas — ficam
-- retidas pra eventual revisão manual.
-- Verificação: SELECT COUNT(*) FROM wja_contact_notes WHERE worker_id IS NULL;
