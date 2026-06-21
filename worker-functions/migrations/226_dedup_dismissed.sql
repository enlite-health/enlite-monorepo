-- Migration 226: dedup_dismissed — grupos de dedup dispensados pelo admin
--
-- CONTEXTO:
--   O endpoint POST /api/admin/dedup/dismiss permite que o admin marque
--   um grupo de phone_normalized como "não é duplicado" de forma persistente.
--   O grupo não volta para a fila de duplicados pendentes após a dispensa.
--
-- ALTERNATIVA DESCARTADA:
--   Adicionar dismissed_at em worker_phone_collisions seria mais simples, mas
--   a tabela worker_phone_collisions só registra grupos que FORAM detectados
--   pela migration 220. Um grupo pode ser dispensado mesmo sem colisão ativa
--   (ex.: admin quer pré-marcar um número como legítimo). Tabela dedicada é mais
--   flexível e não polui o schema de worker_phone_collisions.
--
-- IDEMPOTÊNCIA:
--   CREATE TABLE IF NOT EXISTS + índice IF NOT EXISTS — re-executar é seguro.

CREATE TABLE IF NOT EXISTS dedup_dismissed (
  id               BIGSERIAL    PRIMARY KEY,

  -- Chave do grupo dispensado
  phone_normalized TEXT         NOT NULL,

  -- Razão opcional informada pelo admin
  reason           TEXT,

  -- Quem dispensou (auth_uid do admin)
  dismissed_by     TEXT,

  dismissed_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_dedup_dismissed_phone
    UNIQUE (phone_normalized)
);

COMMENT ON TABLE dedup_dismissed IS
  'Grupos de dedup (por phone_normalized) dispensados manualmente pelo admin. '
  'Um registro nesta tabela remove o grupo da fila de duplicados pendentes '
  'de forma permanente (não volta para a fila). '
  'Dispensar não bloqueia merges futuros — apenas esconde da listagem de admin.';

COMMENT ON COLUMN dedup_dismissed.phone_normalized IS
  'Telefone normalizado (13 dígitos, formato Argentina) identificando o grupo. '
  'UNIQUE: cada grupo pode ser dispensado apenas uma vez.';

COMMENT ON COLUMN dedup_dismissed.dismissed_by IS
  'auth_uid do admin que fez a dispensa. Permite auditoria de quem dispensou.';

-- Índice por dismissed_at para histórico cronológico
CREATE INDEX IF NOT EXISTS idx_dedup_dismissed_at
  ON dedup_dismissed (dismissed_at DESC);

DO $$ BEGIN
  RAISE NOTICE 'Migration 226 concluída: tabela dedup_dismissed criada';
END $$;
