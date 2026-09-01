-- 299_message_template_drafts_submission.sql
--
-- A submissão: o que acontece com o rascunho quando ele deixa de ser rascunho.
--
-- 🔒 REGISTRO DE DECISÃO — o parecer do `lex` NÃO foi emitido.
-- A regra do projeto (CLAUDE.md) exige `lex` antes de implementar mudança que
-- escreve para fora do perímetro, e submeter template à Meta é exatamente isso.
-- O Gabriel determinou explicitamente, em 31/08/2026, construir o fluxo inteiro
-- sem o parecer. Fica registrado aqui porque migration é o que sobrevive: quem
-- ler este arquivo daqui a um ano precisa saber que o portão foi contornado por
-- decisão dele, e não por esquecimento de quem escreveu.
--
-- O que estas colunas guardam: o instante em que o texto deixou de ser nosso.
-- Depois de submetido, o rascunho vira REGISTRO HISTÓRICO — a spec pede que
-- editar deixe de ser possível e a tela ofereça "duplicar e corrigir", porque o
-- que foi mandado para a Meta não pode ser reescrito por baixo.
--
-- Aditiva, nullable, idempotente.

ALTER TABLE message_template_drafts
  ADD COLUMN IF NOT EXISTS content_sid      VARCHAR(64),
  ADD COLUMN IF NOT EXISTS submitted_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS submitted_by     VARCHAR(128),
  ADD COLUMN IF NOT EXISTS submission_error TEXT;

-- Um `content_sid` aponta para um Content da Twilio, e dois rascunhos não podem
-- reivindicar o mesmo. Parcial porque a esmagadora maioria é NULL (não submetido).
CREATE UNIQUE INDEX IF NOT EXISTS message_template_drafts_content_sid
  ON message_template_drafts (content_sid)
  WHERE content_sid IS NOT NULL;

COMMENT ON COLUMN message_template_drafts.content_sid IS
  'SID do Content criado na Twilio no momento da submissao. NULL = nunca submetido. Preenchido, o rascunho vira registro historico e nao pode mais ser editado (a tela oferece duplicar).';

COMMENT ON COLUMN message_template_drafts.submitted_at IS
  'Quando foi submetido a Meta. NULL = nunca. Junto com submitted_by, e a trilha de autoria do ato irreversivel.';

COMMENT ON COLUMN message_template_drafts.submission_error IS
  'Ultima falha de submissao, em texto. Guardado para que a pessoa veja o que houve em vez de so um botao que nao funciona. Limpo no proximo sucesso.';
