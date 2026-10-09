-- 505 — Aba Admissão (spec 049, F1): vínculo do operador com a conta do Tactiq
--
-- POR QUÊ: a transcrição nasce na conta do Tactiq de quem conduz a reunião; o sistema só importa com o vínculo vivo daquela
-- pessoa (spec §3.0.1). Uma linha por responsável (e-mail do roster), com estado e datas. Sem paciente → sem RLS de paciente.
--
-- O token cifrado (KMS) NUNCA sai em SELECT de rota: o app_runtime recebe SELECT só nas colunas SEM o token (coluna a coluna);
-- quem lê o token (o job, em contexto de sistema) é o app_system. `SELECT *` como runtime falha alto (42501) — de propósito.
--
-- Idempotente (2×). ROLLBACK: migrations/pending/ROLLBACK_505_admission_049_tactiq_links.sql

BEGIN;

CREATE TABLE IF NOT EXISTS tactiq_links (
  id                       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  host_email               TEXT         NOT NULL,
  firebase_uid             VARCHAR(128) NOT NULL,
  status                   TEXT         NOT NULL CHECK (status IN ('linked', 'broken', 'wrong_account', 'revoked')),
  refresh_token_encrypted  TEXT         NULL,
  client_id                TEXT         NULL,
  linked_at                TIMESTAMPTZ  NULL,
  last_check_at            TIMESTAMPTZ  NULL,
  last_check_outcome       TEXT         NULL,
  status_changed_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  last_notified_status     TEXT         NULL,
  missing_since            TIMESTAMPTZ  NULL,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
  -- vínculo vivo sem token não existe
  CONSTRAINT tactiq_links_linked_tem_token CHECK (status <> 'linked' OR refresh_token_encrypted IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tactiq_links_host_email ON tactiq_links (lower(host_email));

-- ⚠️ ALTER DEFAULT PRIVILEGES do banco já deu SELECT/INSERT/UPDATE/DELETE de tabela inteira aos dois papéis ao criar a tabela
-- (medido na stack local): sem este REVOKE o GRANT por coluna abaixo é decorativo e `SELECT *` leria o token.
REVOKE ALL ON tactiq_links FROM app_runtime, app_system;

GRANT SELECT (id, host_email, firebase_uid, status, client_id, linked_at, last_check_at, last_check_outcome,
              status_changed_at, last_notified_status, missing_since, created_at)
  ON tactiq_links TO app_runtime;
GRANT INSERT, UPDATE ON tactiq_links TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON tactiq_links TO app_system;

COMMENT ON TABLE tactiq_links IS
  'Vínculo do responsável da admissão com a conta do Tactiq (spec 049). refresh_token_encrypted = cifrado KMS, só o app_system lê; '
  'o app_runtime não tem SELECT nessa coluna. Sem paciente, sem RLS de paciente.';

COMMIT;
