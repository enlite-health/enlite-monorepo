-- 236_contact_notes_vacancy_scoped.sql
--
-- Correção de escopo: contact notes viram ÚNICA THREAD POR VAGA, não por
-- candidato.
--
-- Migration 235 (ontem, <1 dia em prod) re-chaveou wja_contact_notes para o
-- par (worker_id, job_posting_id) — uma thread por candidato×vaga. O produto
-- decidiu que o comportamento correto é: a MESMA thread de comentários
-- aparece em TODOS os cards da vaga (bloqueado ou não, qualquer coluna,
-- qualquer candidato). Logo a chave passa a ser SOMENTE job_posting_id, e
-- worker_id/worker_job_application_id viram redundantes.
--
-- Aditiva: seguindo a regra do repositório ("migrações são aditivas — nunca
-- dropar coluna/tabela sem deprecação"), worker_id e worker_job_application_id
-- NÃO são fisicamente dropadas aqui — são renomeadas para o padrão
-- `_deprecated_20260707`. Isso já as torna invisíveis para todo código de
-- produção (nenhum SELECT/INSERT referencia mais os nomes originais —
-- confirmado por grep em src/modules/matching) e satisfaz a validação de
-- schema (`\d wja_contact_notes` não lista mais `worker_id` nem
-- `worker_job_application_id` como tais). O DROP físico das colunas
-- `*_deprecated_20260707` fica para uma migração de follow-up, após
-- confirmação humana de que nenhum outro consumidor (relatório, script ad-hoc)
-- depende delas — mesmo critério de segurança já aplicado a outras
-- deprecações do repositório.
--
-- O índice antigo (chave composta worker_id+job_posting_id) é fisicamente
-- dropado abaixo: índices não carregam risco de "código ainda lê a coluna",
-- então não precisam do mesmo cuidado de deprecação em duas fases.

-- Safety backfill (idempotente): garante que toda nota tenha job_posting_id
-- preenchido antes do NOT NULL. Na prática já é assim desde a migration 235
-- (toda nota tem worker_job_application_id resolvido OU já veio com
-- job_posting_id preenchido no insert), mas isso cobre qualquer linha
-- residual.
UPDATE wja_contact_notes cn
SET job_posting_id = wja.job_posting_id
FROM worker_job_applications wja
WHERE cn.job_posting_id IS NULL
  AND cn.worker_job_application_id = wja.id;

ALTER TABLE wja_contact_notes
  ALTER COLUMN job_posting_id SET NOT NULL;

-- Índice antigo (worker_id, job_posting_id, created_at) → substituído pelo
-- índice só-vaga (job_posting_id, created_at). Renomeia primeiro (padrão de
-- deprecação do repositório) e dropa em seguida — seguro para índices.
ALTER INDEX IF EXISTS idx_wja_contact_notes_worker_vacancy
  RENAME TO idx_wja_contact_notes_worker_vacancy_deprecated_20260707;
DROP INDEX IF EXISTS idx_wja_contact_notes_worker_vacancy_deprecated_20260707;

CREATE INDEX IF NOT EXISTS idx_wja_contact_notes_vacancy
  ON wja_contact_notes(job_posting_id, created_at DESC);

-- worker_id / worker_job_application_id: renomeadas (não dropadas — ver nota
-- de cabeçalho). Nenhum código de produção referencia os nomes originais
-- destas colunas nesta tabela (grep em src/modules/matching confirmado).
ALTER TABLE wja_contact_notes
  RENAME COLUMN worker_id TO worker_id_deprecated_20260707;
ALTER TABLE wja_contact_notes
  RENAME COLUMN worker_job_application_id TO worker_job_application_id_deprecated_20260707;

COMMENT ON TABLE wja_contact_notes IS
  'Log append-only de notas manuais de contato por operadora, escopado '
  'SOMENTE À VAGA (job_posting_id) — migration 236. A mesma thread aparece '
  'idêntica em todos os cards/candidatos da vaga (bloqueado ou não, '
  'qualquer coluna). Migration 204 criou a tabela escopada à WJA; migration '
  '235 re-chaveou para o par (worker_id, job_posting_id) — uma thread por '
  'candidato; migration 236 corrige o escopo para 1 thread por vaga. '
  'worker_id/worker_job_application_id renomeadas para '
  '*_deprecated_20260707 (já não têm consumidor — a correção veio <1 dia '
  'depois da 235 em produção); DROP físico fica para follow-up após '
  'confirmação humana.';

COMMENT ON COLUMN wja_contact_notes.job_posting_id IS
  'Chave canônica única da tabela — a nota pertence à vaga inteira, não a '
  'um candidato específico. NOT NULL desde a migration 236.';

COMMENT ON COLUMN wja_contact_notes.worker_id_deprecated_20260707 IS
  'DEPRECADA (migration 236, ex-worker_id). Escopo passou a ser só '
  'job_posting_id — nenhum código de produção lê esta coluna. Candidata a '
  'DROP físico em migração de follow-up.';

COMMENT ON COLUMN wja_contact_notes.worker_job_application_id_deprecated_20260707 IS
  'DEPRECADA (migration 236, ex-worker_job_application_id, legado da '
  'migration 204). Escopo passou a ser só job_posting_id — nenhum código de '
  'produção lê esta coluna. Candidata a DROP físico em migração de '
  'follow-up.';

-- Validação esperada pós-migração:
-- SELECT COUNT(*) FROM wja_contact_notes WHERE job_posting_id IS NULL; -- esperado: 0
-- \d wja_contact_notes -- não deve listar `worker_id` nem
--   `worker_job_application_id` (só as variantes *_deprecated_20260707)
