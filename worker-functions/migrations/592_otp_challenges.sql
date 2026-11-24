-- Migration 592: otp_challenges — código OTP próprio por template de autenticação do WhatsApp (spec 077, D758, PR-INF-46)
--
-- DONO do conceito "código válido" (D514): ESTA tabela. O Twilio Verify deixa de ser o dono no fluxo do app e fica só como
-- plano B de canal. O código NUNCA é gravado em claro: só `code_hmac` = HMAC-SHA256 do código com PEPPER em secret
-- (OTP_HMAC_PEPPER), ligado ao id do desafio e à finalidade. Nada derivado é gravado: "vencido" é função de `expires_at`
-- (vigência explícita) lida na conferência; `status` guarda só o que aconteceu (pending/consumed/canceled), não o relógio.
--
-- Finalidade (`purpose`) é CHECK com LISTA, de propósito: acrescentar uma finalidade nova é
--   ALTER TABLE otp_challenges DROP CONSTRAINT otp_challenges_purpose_check,
--     ADD CONSTRAINT otp_challenges_purpose_check CHECK (purpose IN ('claim','link','phone_verify', '<nova>'));
-- sem recriar tabela, sem tocar dado (relaxar a lista nunca invalida linha existente).
--
-- Finalidades: `claim` e `link` (conta/vínculo) e `phone_verify` (celular verificado, emenda §3.2: o SERVIDOR decide a
-- finalidade; o cliente não a escolhe). Entrou na própria 592 porque ela ainda não foi para a main.
--
-- Um desafio PENDENTE por (ficha, finalidade): índice único parcial. Um start de outra finalidade não cancela este.
-- `phone_e164` é o telefone para o qual o código foi emitido (DP-21: a conferência o compara com o telefone da FICHA).
-- PII: telefone e código não vão para log; a trilha usa o id do desafio.
-- Privilégios: nada de GRANT/REVOKE (a migration roda como enlite_app, dono; nenhum REVOKE no próprio dono).
-- Idempotente (2x): IF NOT EXISTS. Sem BEGIN/COMMIT próprio (o runner envolve).
--
-- Rollback: `migrations/pending/ROLLBACK_592_otp_challenges.sql` (derruba a tabela; códigos pendentes se perdem).

CREATE TABLE IF NOT EXISTS otp_challenges (
  id          UUID PRIMARY KEY,
  worker_id   UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL,
  phone_e164  TEXT NOT NULL,
  code_hmac   TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'pending',
  twilio_sid  TEXT,
  send_status TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT otp_challenges_purpose_check CHECK (purpose IN ('claim', 'link', 'phone_verify')),
  CONSTRAINT otp_challenges_status_check CHECK (status IN ('pending', 'consumed', 'canceled')),
  CONSTRAINT otp_challenges_attempts_check CHECK (attempts >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_otp_challenges_pending_por_ficha_finalidade
  ON otp_challenges (worker_id, purpose) WHERE status = 'pending';

COMMENT ON TABLE otp_challenges IS 'Código OTP próprio (D758). Dono do conceito "código válido". Só o HMAC do código; nunca em claro.';
COMMENT ON COLUMN otp_challenges.code_hmac IS 'HMAC-SHA256(pepper, id|purpose|code) em hex. O código nunca é gravado.';
