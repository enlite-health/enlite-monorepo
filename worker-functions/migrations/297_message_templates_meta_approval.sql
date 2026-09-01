-- 297_message_templates_meta_approval.sql
--
-- O estado de autorização do template na Meta, trazido para o banco.
--
-- Por que agora: o estado JÁ era buscado e jogado fora. O
-- `collectApprovedTwilio` de `scripts/sync-message-templates-twilio.ts` chamava
-- `fetchWhatsAppApproval` para cada Content e guardava só o que voltava
-- `approved` — o resto ia para o lixo a cada sync. Fora do banco, a única
-- resposta para "este template está autorizado?" era `docs/SPRINT_WHATSAPP_
-- TEMPLATES_AR.md`, escrito à mão em 19/05/2026, com `Owner: _TBD_`.
--
-- Por que a fonte é a META e não a Twilio (medido em 31/08/2026):
--   - a Twilio reporta 5 estados; a Meta reporta 10 (inclui PAUSED, DISABLED,
--     IN_APPEAL, LIMIT_EXCEEDED — os que dizem que uma mensagem NO AR foi
--     desligada). O que a Twilio não representa, nós não enxergávamos.
--   - o motivo da recusa que a Twilio repassa vem seco: a documentação dela diz
--     que `INVALID_FORMAT` chega "without explaining details". A Meta manda,
--     junto, a explicação em prosa e a recomendação de conserto.
--   - a junção é determinística: o nome do template na Meta é
--     `<friendly_name do Content>_<content_sid em minúsculas>`. Medido: 27 de 27
--     casam com o SID exato, e ZERO templates da WABA existem sem esse sufixo —
--     ou seja, todos nasceram na Twilio.
--
-- `meta_approval_status` é TEXT e não enum de banco DE PROPÓSITO: a Meta
-- acrescenta estado sem avisar, e enum viraria uma migration a cada mudança
-- deles. A regra é guardar o que veio — inclusive o que não conhecemos. Estado
-- desconhecido tratado como "não aprovado" seria mentira; descartado seria pior
-- (foi exatamente o descarte que escondeu 5 dos 10 estados até hoje).
--
-- Aditiva e nullable: quem nunca foi verificado fica NULL, e a tela diz "sin
-- verificar" em vez de inventar um estado.

ALTER TABLE message_templates
  ADD COLUMN IF NOT EXISTS meta_approval_status     TEXT,
  ADD COLUMN IF NOT EXISTS meta_approval_reason     TEXT,
  ADD COLUMN IF NOT EXISTS meta_approval_detail     TEXT,
  ADD COLUMN IF NOT EXISTS meta_approval_checked_at TIMESTAMPTZ;

COMMENT ON COLUMN message_templates.meta_approval_status IS
  'Estado do template na Meta, como veio (APPROVED, PENDING, REJECTED, PAUSED, DISABLED, IN_APPEAL, LIMIT_EXCEEDED, ARCHIVED, PENDING_DELETION, DELETED, ou um estado novo que eles criem). TEXT e nao enum: a Meta acrescenta estado sem avisar. NULL = nunca verificado.';

COMMENT ON COLUMN message_templates.meta_approval_reason IS
  'Codigo do motivo da recusa, conjunto fechado da Meta: ABUSIVE_CONTENT, CATEGORY_NOT_AVAILABLE, INCORRECT_CATEGORY, INVALID_FORMAT, NONE, PROMOTIONAL, SCAM, TAG_CONTENT_MISMATCH. NULL quando nao houve recusa.';

COMMENT ON COLUMN message_templates.meta_approval_detail IS
  'Explicacao em prosa da Meta (rejection_info), quando ela manda — o que esta errado e como consertar. NULL na maioria dos casos; a Twilio nunca repassa este campo.';

COMMENT ON COLUMN message_templates.meta_approval_checked_at IS
  'Quando o estado foi lido da Meta pela ultima vez. NULL = nunca. A tela mostra a idade do dado em vez de fingir que esta fresco.';
