-- 509 — `vacancy_source_change_notices`: aviso na vaga PUBLICADA quando um campo do serviço contratado que ela lê
-- muda (change vaga-le-do-servico-contratado, F3; design.md §Aviso de vaga publicada).
--
-- POR QUÊ: a vaga lê horário (e, nas fases 5/6, quantidade e faixa etária) do serviço contratado. Quando o serviço muda
-- com a vaga já publicada no Talentum, o recrutamento precisa SABER (republicar e avisar convidados é decisão humana).
-- Esta tabela é só o aviso. NÃO guarda valor antigo nem novo — guardar seria outra cópia do dado que tem dona.
--
-- Um aviso ABERTO por (vaga, campo): índice único parcial `WHERE acknowledged_at IS NULL`. Nova mudança com aviso aberto
-- atualiza `changed_at` (upsert); depois do "marcar como atendido" o próximo aviso entra como linha nova.
--
-- Molde: 476_job_posting_notes (filha de job_postings; job_postings não tem RLS — 271:36, 413:12 —, então esta também não).
-- GRANT explícito por tabela a app_runtime/app_system; SEM `ALTER DEFAULT PRIVILEGES`. O default privilege do banco concede
-- também DELETE: tirado abaixo (aviso não se apaga, só a cascata da vaga).
--
-- Idempotente (2×). Rollback (só com a tabela vazia ou aceitando perder avisos): DROP TABLE IF EXISTS vacancy_source_change_notices;
-- (sem BEGIN/COMMIT: o runner já envolve cada arquivo numa transação — molde 476.)
CREATE TABLE IF NOT EXISTS vacancy_source_change_notices (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  job_posting_id   UUID         NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE,
  field            TEXT         NOT NULL,
  changed_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  acknowledged_at  TIMESTAMPTZ  NULL,
  acknowledged_by  VARCHAR(128) NULL,
  CONSTRAINT vscn_field_check CHECK (field IN ('schedule', 'providers_needed', 'age_range')),
  CONSTRAINT vscn_ack_pair_check CHECK ((acknowledged_at IS NULL) = (acknowledged_by IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_vscn_open_per_vacancy_field
  ON vacancy_source_change_notices (job_posting_id, field)
  WHERE acknowledged_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON vacancy_source_change_notices TO app_runtime, app_system;
REVOKE DELETE ON vacancy_source_change_notices FROM app_runtime, app_system;

COMMENT ON TABLE vacancy_source_change_notices IS
  'Aviso de que um campo do serviço contratado mudou com a vaga publicada (vaga-le-do-servico F3). Sem valor antigo/novo. Um aberto por (vaga, campo).';

