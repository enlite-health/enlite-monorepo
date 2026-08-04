-- 259_account_link_events.sql
--
-- Vínculo self-service de contas (openspec: vinculo-contas-colisao-telefone, Bloco 2).
--
-- Telemetria durável do funil de vínculo E fonte do rate-limit de start
-- (3/h por conta = COUNT nesta tabela — sobrevive a múltiplas instâncias,
-- diferente de um contador em memória). Também é a "fila" consultável dos
-- REQUIRES_REVIEW (degrau de conta de alto valor).

CREATE TABLE IF NOT EXISTS account_link_events (
  id BIGSERIAL PRIMARY KEY,
  -- lookup | started | confirmed | conflicts_shown | merged | requires_review
  -- | undone | notice_email_sent | notice_email_skipped
  event TEXT NOT NULL,
  -- conta LOGADA (survivor do vínculo)
  worker_id UUID,
  -- dona do telefone (absorvida no vínculo)
  other_worker_id UUID,
  merge_audit_id BIGINT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Rate-limit: COUNT(event='started' AND worker_id=X AND created_at > NOW()-1h)
CREATE INDEX IF NOT EXISTS idx_account_link_events_worker_event_time
  ON account_link_events (worker_id, event, created_at);

-- Fila de revisão do degrau de alto valor (admin consulta os pendentes)
CREATE INDEX IF NOT EXISTS idx_account_link_events_review
  ON account_link_events (event, created_at) WHERE event = 'requires_review';

COMMENT ON TABLE account_link_events IS
  'Funil do vínculo self-service por colisão de telefone: telemetria + rate-limit + fila de revisão';
