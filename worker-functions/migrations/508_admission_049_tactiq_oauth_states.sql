-- 508 — Aba Admissão (spec 049, F4): estado do fluxo OAuth do vínculo Tactiq (cliente PÚBLICO, PKCE S256)
--
-- POR QUÊ: o Tactiq registrou o cliente como público (`token_endpoint_auth_method=none`, sem client_secret): a única
-- prova do fluxo é o PKCE. O `code_verifier` nasce no clique "Vincular Tactiq" e é usado no callback — que é uma
-- navegação do browser, em OUTRA instância do Cloud Run, sem header de autorização. Precisa de lugar compartilhado:
-- esta tabela. Guarda o hash do `state` (o state cru só existe na URL), o verifier CIFRADO (KMS), o dono (uid + e-mail),
-- validade de 10 min e USO ÚNICO (`consumed_at`).
--
-- Idempotente (2×). ROLLBACK: migrations/pending/ROLLBACK_508_admission_049_tactiq_oauth_states.sql

BEGIN;

CREATE TABLE IF NOT EXISTS tactiq_oauth_states (
  state_hash                TEXT         PRIMARY KEY,
  firebase_uid              VARCHAR(128) NOT NULL,
  host_email                TEXT         NOT NULL,
  code_verifier_encrypted   TEXT         NOT NULL,
  expires_at                TIMESTAMPTZ  NOT NULL,
  consumed_at               TIMESTAMPTZ  NULL,
  created_at                TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tactiq_oauth_states_expires ON tactiq_oauth_states (expires_at);

REVOKE ALL ON tactiq_oauth_states FROM app_runtime, app_system;
GRANT SELECT, INSERT, UPDATE, DELETE ON tactiq_oauth_states TO app_runtime, app_system;

COMMENT ON TABLE tactiq_oauth_states IS
  'Estado do OAuth do Tactiq (spec 049 F4): hash do state, code_verifier cifrado (KMS), validade 10 min, uso único. Sem paciente, sem RLS de paciente.';

COMMIT;
