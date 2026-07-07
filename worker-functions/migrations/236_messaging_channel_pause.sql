-- Migration 236: kill-switch de canal de mensageria (messaging_channel_pause)
--
-- CONTEXTO: fallback instantâneo do provider Periskope sem deploy. Se o
-- Periskope apresentar instabilidade, um operador seta paused=true nesta
-- tabela e RoutingMessagingService (via MessagingChannelPauseCache, TTL
-- 15-30s) para de despachar pro canal periskope — o outbox trata a falha
-- como reprocessável (não incrementa attempts), então nada se perde.
--
-- Idempotente: IF NOT EXISTS + seed via ON CONFLICT DO NOTHING.

CREATE TABLE IF NOT EXISTS messaging_channel_pause (
  channel    VARCHAR(20)  PRIMARY KEY,
  paused     BOOLEAN      NOT NULL DEFAULT false,
  paused_at  TIMESTAMPTZ  NULL,
  paused_by  TEXT         NULL
);

COMMENT ON TABLE messaging_channel_pause IS
  'Kill-switch por canal de mensageria. paused=true faz RoutingMessagingService '
  'recusar novos envios nesse canal (Result.fail reprocessável, nunca erro fatal). '
  'Lido com cache em memória de curta duração (MessagingChannelPauseCache).';

COMMENT ON COLUMN messaging_channel_pause.channel IS
  'Nome do canal: twilio | periskope (mesmo vocabulário de workers.messaging_channel).';

COMMENT ON COLUMN messaging_channel_pause.paused IS
  'true = canal pausado; RoutingMessagingService recusa despachar novos envios.';

COMMENT ON COLUMN messaging_channel_pause.paused_at IS
  'Timestamp de quando o canal foi pausado (NULL enquanto nunca pausado).';

COMMENT ON COLUMN messaging_channel_pause.paused_by IS
  'Identificador do operador/processo que pausou o canal (auditoria).';

INSERT INTO messaging_channel_pause (channel, paused)
VALUES ('periskope', false)
ON CONFLICT (channel) DO NOTHING;
