-- ============================================================
-- Migration 174: Insert vacancy_invited_auto message template
--
-- Template para convite automático enviado a ATs após matchmaking
-- pós-criação de vaga. Disparado pelo VacancyAutoInviteHandler.
--
-- ATENÇÃO (deploy em produção):
--   content_sid deve ser preenchido com o SID do HSM aprovado no
--   Twilio Console ANTES do deploy. WhatsApp Business rejeita
--   mensagens proativas sem HSM aprovado. Atualizar via:
--     UPDATE message_templates SET content_sid = 'HXxxxx' WHERE slug = 'vacancy_invited_auto';
-- ============================================================

INSERT INTO message_templates (slug, name, body, category, is_active, content_sid)
VALUES (
  'vacancy_invited_auto',
  'Convite automático para vaga (pós-match)',
  '¡Hola {{worker_name}}! Tenemos una vacante para vos: CASO {{vacancy_case_number}} en {{patient_zone}} (a {{distance_km}}km de tu zona). ¿Te interesa? Responde "Sí" o "No".',
  'auto_invite',
  true,
  NULL
)
ON CONFLICT (slug) DO NOTHING;
