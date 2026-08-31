-- 295_message_templates_body_twilio.sql
--
-- `body_twilio`: o texto REAL do template, como está aprovado na Meta, trazido
-- da Content API pelo sync. É coluna de EXIBIÇÃO — a tela mostra ao staff o que
-- a cuidadora vai receber antes de ligar a etapa.
--
-- Por que não reaproveitar `body`: `body` é CONTRATO DE ENVIO. O
-- TwilioMessagingService chama `mapToContentVariables(template.body, vars)`, que
-- lê os placeholders NOMEADOS do corpo salvo ({{worker_name}}, {{case_number}})
-- e os mapeia, NA ORDEM, para as contentVariables posicionais que a Twilio
-- espera ("1", "2", …). Os corpos da Twilio são 100% posicionais (medido:
-- 28/28 Contents da conta em 31/08/2026). Sobrescrever `body` com o texto de lá
-- faria duas coisas ao mesmo tempo: quebraria o envio (valor nomeado perde o
-- slot) e zeraria a elegibilidade por etapa (posicional não passa no lex C4).
-- Por isso são duas colunas, e o sync nunca cruza uma na outra.
--
-- Aditiva e nullable: quem nunca sincronizou fica com NULL, e a tela diz
-- "sin texto sincronizado" em vez de inventar mensagem.

ALTER TABLE message_templates
  ADD COLUMN IF NOT EXISTS body_twilio TEXT;

COMMENT ON COLUMN message_templates.body_twilio IS
  'Texto aprovado na Meta, vindo da Content API (posicional {{1}}). Só exibição — nunca usado para enviar; o contrato de envio é message_templates.body.';
