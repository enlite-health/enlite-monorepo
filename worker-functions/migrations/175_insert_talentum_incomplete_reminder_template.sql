-- Template "talentum_incomplete_reminder" — lembrete para workers em INITIATED/IN_PROGRESS há >5 dias
-- IMPORTANTE: content_sid NULL aqui. Antes do go-live em produção, Ops deve obter
-- aprovação HSM no Twilio Console e popular content_sid com UPDATE.
INSERT INTO message_templates (slug, name, body, category, is_active, content_sid)
VALUES (
  'talentum_incomplete_reminder',
  'Lembrete de prescreening Talentum incompleto',
  '¡Hola {{worker_name}}! Notamos que tu proceso de selección en Enlite está pendiente de completar. ¿Podemos ayudarte? Escribinos para retomarlo.',
  'auto_reminder',
  true,
  NULL
)
ON CONFLICT (slug) DO NOTHING;
