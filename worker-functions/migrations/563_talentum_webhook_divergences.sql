-- 563 — `talentum_webhook_divergences`: uma linha por evento do webhook Talentum que NÃO conseguiu gravar o card
-- direito (worker não resolvido, vaga não resolvida, vaga só por título, vaga gravada ≠ dona do prescreening_id —
-- esta última em dois sabores: REPOINTED_TO_OWNER = a dona por id venceu e a gravada foi trocada; TITLE_DIFFERS_STORED =
-- só o título resolveu, diferente da gravada, e a gravada foi mantida).
--
-- Por quê: o Talentum é a fonte da verdade do status/score do pré-screening e o card é o ESPELHO dele; defeito é
-- o card divergir. Hoje esses caminhos só davam `console.error` com HTTP 200 — ninguém lia. A linha é gravada na
-- MESMA transação do card (talentum_prescreenings); o chamador também aciona o `reportError`. Não existia tabela
-- de alerta/divergência reaproveitável (busca em migrations/ por alert/diverg/discrep/inconsist/anomal: só
-- `itinerary_uncovered_alert_dispatch`, que é despacho de e-mail de itinerário).
--
-- Só ids, tipo e ambiente — SEM PII (nada de telefone, e-mail, nome, CUIL). `resolved_at` é para a operação
-- fechar a divergência depois; nada no webhook o preenche.
-- DDL de dono (roda como enlite_app). Rollback: DROP TABLE talentum_webhook_divergences;
CREATE TABLE IF NOT EXISTS talentum_webhook_divergences (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                     TEXT NOT NULL CHECK (kind IN (
                             'WORKER_NULL',
                             'JOB_POSTING_NULL',
                             'JOB_POSTING_BY_TITLE_ONLY',
                             'JOB_POSTING_TITLE_DIFFERS_STORED',
                             'JOB_POSTING_REPOINTED_TO_OWNER')),
  talentum_prescreening_id VARCHAR(255) NOT NULL,
  talentum_profile_id      VARCHAR(255) NOT NULL,
  prescreening_id          UUID REFERENCES talentum_prescreenings(id) ON DELETE SET NULL,
  worker_id                UUID,
  job_posting_id           UUID,
  expected_job_posting_id  UUID,
  environment              TEXT NOT NULL DEFAULT 'production',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at              TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_talentum_webhook_divergences_aberta
  ON talentum_webhook_divergences (created_at DESC) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_talentum_webhook_divergences_prescreening
  ON talentum_webhook_divergences (talentum_prescreening_id);

COMMENT ON TABLE talentum_webhook_divergences IS
  'Divergência webhook Talentum × card (espelho). Só ids/tipo; sem PII. Gravada na transação do card.';

GRANT SELECT, INSERT, UPDATE ON talentum_webhook_divergences TO app_runtime, app_system;
