-- Migration 182: Adiciona buttons à tabela de templates
--
-- Armazena os labels e payloads dos botões definidos no Twilio Content API
-- pra cada template. Usado pelo espelho Chatwoot — quando uma outbound é
-- enviada via Twilio, o sistema posta uma mensagem outgoing no Chatwoot
-- com o texto interpolado + "[Opciones: <label1> | <label2>]" no fim, para
-- que a agente humana entenda a qual pergunta o worker está respondendo.
--
-- Formato: JSONB array — [{"label": "Sí", "payload": "confirm_yes"}, ...]
-- NULL quando o template não tem botões (mensagem de texto puro).

ALTER TABLE message_templates
  ADD COLUMN IF NOT EXISTS buttons JSONB DEFAULT NULL;

COMMENT ON COLUMN message_templates.buttons IS
  'Botões quick-reply definidos no Twilio Content API. Formato:
   [{"label": "<texto exibido>", "payload": "<button_payload>"}, ...].
   NULL quando o template é texto puro. Populado via
   scripts/populate-template-buttons.ts a partir do Twilio Content API.';
