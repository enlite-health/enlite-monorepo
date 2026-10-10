-- 505 — Aba Admissão (spec 049, F1): vínculo do operador com a conta do Tactiq
--
-- POR QUÊ: a transcrição nasce na conta do Tactiq de quem conduz a reunião; o sistema só importa com o vínculo vivo daquela
-- pessoa (spec §3.0.1). Uma linha por responsável (e-mail do roster), com estado e datas. Sem paciente → sem RLS de paciente.
--
-- O token cifrado (KMS) NUNCA é legível pelo app_runtime. A régua de `runtime-role-privilegios.e2e.test.ts` exige SELECT de
-- TABELA INTEIRA para o runtime em toda tabela (exceção só para trilha append-only particionada) — então GRANT por coluna não
-- serve. Solução: o token mora em OUTRA tabela, `tactiq_link_secrets`, com RLS ligada e policy só para `app_system`:
--   · o runtime tem o privilégio de tabela (a régua passa), mas a RLS não lhe entrega nenhuma linha (SELECT = 0 linhas) e ele
--     não tem INSERT/UPDATE/DELETE (42501);
--   · `tactiq_links` (estado, datas, e-mail) fica legível pelo runtime inteira, sem token.
-- Quem lê/grava o token é o app_system (callback do OAuth e job diário, ambos em contexto de sistema).
--
-- Idempotente (2×). ROLLBACK: migrations/pending/ROLLBACK_505_admission_049_tactiq_links.sql

BEGIN;

CREATE TABLE IF NOT EXISTS tactiq_links (
  id                       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  host_email               TEXT         NOT NULL,
  firebase_uid             VARCHAR(128) NOT NULL,
  status                   TEXT         NOT NULL CHECK (status IN ('linked', 'broken', 'wrong_account', 'revoked')),
  client_id                TEXT         NULL,
  linked_at                TIMESTAMPTZ  NULL,
  last_check_at            TIMESTAMPTZ  NULL,
  last_check_outcome       TEXT         NULL,
  status_changed_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  last_notified_status     TEXT         NULL,
  missing_since            TIMESTAMPTZ  NULL,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tactiq_links_host_email ON tactiq_links (lower(host_email));

-- O token cifrado (KMS), isolado do papel de runtime pela RLS (ver cabeçalho). Uma linha por vínculo.
CREATE TABLE IF NOT EXISTS tactiq_link_secrets (
  link_id                  UUID         PRIMARY KEY REFERENCES tactiq_links(id) ON DELETE CASCADE,
  refresh_token_encrypted  TEXT         NOT NULL,
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT now()
);

ALTER TABLE tactiq_link_secrets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tactiq_link_secrets_system_only ON tactiq_link_secrets;
CREATE POLICY tactiq_link_secrets_system_only ON tactiq_link_secrets
  FOR ALL TO app_system USING (true) WITH CHECK (true);

-- ALTER DEFAULT PRIVILEGES do banco já dá SELECT/INSERT/UPDATE/DELETE de tabela inteira aos dois papéis ao criar a tabela
-- (medido na stack local): REVOGA e concede só o que o desenho quer.
REVOKE ALL ON tactiq_links, tactiq_link_secrets FROM app_runtime, app_system;

GRANT SELECT, INSERT, UPDATE ON tactiq_links TO app_runtime, app_system;
-- runtime: só o privilégio de SELECT (a régua exige); a RLS devolve 0 linhas. Escrita: só o sistema.
GRANT SELECT ON tactiq_link_secrets TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON tactiq_link_secrets TO app_system;

COMMENT ON TABLE tactiq_links IS
  'Vínculo do responsável da admissão com a conta do Tactiq (spec 049). Sem token: ele vive em tactiq_link_secrets. Sem paciente, sem RLS de paciente.';
COMMENT ON TABLE tactiq_link_secrets IS
  'Refresh token do Tactiq cifrado (KMS) — RLS: só o app_system enxerga/escreve linhas; o app_runtime lê 0 linhas.';

COMMIT;
