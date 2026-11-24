-- Migration 593: worker_devices — o aparelho ATIVO da cuidadora (spec 077, D795, PR-INF-DB / T-F3c-DB-10)
--
-- DONO do conceito "qual aparelho pode falar pela conta da cuidadora" (D514): ESTA tabela. Regra de negócio NO BANCO:
-- índice único parcial `WHERE status = 'ativo'` por worker — o 2º aparelho ativo da mesma cuidadora FALHA no banco,
-- não só no código. Quem liga um aparelho novo desliga o anterior NA MESMA transação (RegisterDevice).
--
-- Nada derivado é gravado: "tem aparelho ativo" é função de `status`; não há coluna de contagem nem de "último contato".
-- `status` + `revoked_reason` guardam o que ACONTECEU com o aparelho; cada NULL tem UM só significado:
--   · revoked_at / revoked_by / revoked_reason NULL  = aparelho ainda ativo (o CHECK worker_devices_revogacao_completa
--     exige os três juntos quando revogado);
--   · revoked_by NULL com status 'revogado' = revogado por SUBSTITUIÇÃO (login em outro celular), não por operador;
--     por isso `revoked_reason` existe: sem ele o NULL de revoked_by teria dois sentidos (substituído × não sabido);
--   · wiped_at NULL = o servidor NÃO ouviu o aparelho confirmar o apagamento (não é "não apagou"). Preenchido uma só vez.
--   · fcm_token_enc NULL = o app não informou token de push (sem push, só vale o DEVICE_REVOKED na próxima chamada).
--
-- PII / dado pessoal (CO-1): chave pública de vínculo e id da instalação são identificadores (não são dado de saúde);
-- o token FCM é identificador e NUNCA é gravado em claro: `fcm_token_enc` = ciphertext KMS (KMSEncryptionService, base64).
-- Nenhum desses três vai a log. Nenhum dado de saúde entra nesta tabela.
-- Retenção: enquanto o aparelho for o ativo; o histórico de revogados guarda quem/quando (trilha do painel).
--
-- Privilégios: nada de GRANT/REVOKE (a migration roda como enlite_app, dono; nenhum REVOKE no próprio dono — LISTA 19/551).
-- Idempotente (2x): IF NOT EXISTS. Sem BEGIN/COMMIT próprio (o runner envolve).
--
-- Rollback: `migrations/pending/ROLLBACK_593_worker_devices.sql` (derruba a tabela; o vínculo some, a cuidadora liga de novo no próximo login).

CREATE TABLE IF NOT EXISTS worker_devices (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id       UUID        NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  installation_id UUID        NOT NULL,
  public_key      TEXT        NOT NULL CHECK (length(public_key) BETWEEN 1 AND 2048),
  fcm_token_enc   TEXT,
  status          TEXT        NOT NULL DEFAULT 'ativo',
  registered_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at      TIMESTAMPTZ,
  revoked_by      TEXT,
  revoked_reason  TEXT,
  wiped_at        TIMESTAMPTZ,
  CONSTRAINT worker_devices_status_check CHECK (status IN ('ativo', 'revogado')),
  CONSTRAINT worker_devices_motivo_check CHECK (revoked_reason IS NULL OR revoked_reason IN ('operador', 'substituido')),
  CONSTRAINT worker_devices_revogacao_completa CHECK (
    (status = 'ativo' AND revoked_at IS NULL AND revoked_by IS NULL AND revoked_reason IS NULL)
    OR
    (status = 'revogado' AND revoked_at IS NOT NULL AND revoked_reason IS NOT NULL
      AND ((revoked_reason = 'operador' AND revoked_by IS NOT NULL AND length(trim(revoked_by)) > 0)
        OR (revoked_reason = 'substituido' AND revoked_by IS NULL)))
  )
);

-- UM aparelho ATIVO por cuidadora (D795). O histórico de revogados não entra no índice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_worker_devices_ativo_por_worker
  ON worker_devices (worker_id) WHERE status = 'ativo';

COMMENT ON TABLE worker_devices IS
  'Aparelho da cuidadora (D795). Dono do conceito "aparelho ativo": índice único parcial uq_worker_devices_ativo_por_worker. Revogar é um registro, nunca DELETE.';
COMMENT ON COLUMN worker_devices.fcm_token_enc IS
  'Token FCM cifrado (KMS, base64). Nunca em claro, nunca em log. NULL = o app não informou token.';
COMMENT ON COLUMN worker_devices.revoked_by IS
  'firebase_uid do operador que revogou. NULL só quando revoked_reason = substituido (login em outro aparelho).';
COMMENT ON COLUMN worker_devices.wiped_at IS
  'Quando o aparelho confirmou o apagamento (POST wiped). NULL = o servidor não ouviu o aparelho; NÃO significa que não apagou.';
