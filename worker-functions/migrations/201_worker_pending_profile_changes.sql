-- Migration 201: worker_pending_profile_changes
-- Staging de mudanças de perfil propostas pela Luz (agente IA via triage) antes
-- da confirmação explícita do worker (fluxo propose/confirm).
--
-- O servidor detém a autoridade: o valor validado fica AQUI (criptografado), e o
-- confirm aplica exatamente o que foi estacionado — a Luz não consegue trocar o
-- valor entre propor e confirmar. O `id` é o handle opaco devolvido no propose.
--
-- payload_encrypted: JSON dos campos validados, criptografado via Cloud KMS
-- (mesma postura de PII-at-rest do resto do schema). TTL curto (expires_at).

CREATE TABLE IF NOT EXISTS worker_pending_profile_changes (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id         UUID         NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  conversation_ref  VARCHAR(120) NULL,
  payload_encrypted TEXT         NOT NULL,
  field_names       TEXT[]       NOT NULL,
  status            VARCHAR(20)  NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'consumed', 'expired')),
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  expires_at        TIMESTAMPTZ  NOT NULL,
  consumed_at       TIMESTAMPTZ  NULL
);

-- Lookup do confirm: pendentes de um worker, mais recentes primeiro.
CREATE INDEX IF NOT EXISTS idx_pending_profile_changes_worker_pending
  ON worker_pending_profile_changes(worker_id, created_at DESC)
  WHERE status = 'pending';

COMMENT ON TABLE worker_pending_profile_changes IS
  'Staging propose/confirm de updates de perfil pela Luz. payload_encrypted = JSON via KMS. id = handle opaco. Expira em expires_at.';
