-- AR WhatsApp templates (8) — Sprint AR recruitment automation
-- See: docs/SPRINT_WHATSAPP_TEMPLATES_AR.md
-- Templates created in Twilio + approved by Meta on 2026-05-20.
-- Mix: 6 MARKETING + 2 UTILITY. Body marcado como placeholder —
-- conteúdo canônico mora no Twilio Content API (referenciado via content_sid).
-- A migration 178 sobrescreve os slugs ar_vacancy_match_* com body e content_sid corretos.

INSERT INTO message_templates (slug, name, body, category, is_active, content_sid)
VALUES
  ('ar_invite_luz_personal',
   'AR · Invitación Luz personal',
   '(ver Twilio Content Builder: HX5d77ccab1689ab6cf9b675a0b158e68d)',
   'recruitment',
   true,
   'HX5d77ccab1689ab6cf9b675a0b158e68d'),

  ('ar_invite_open',
   'AR · Invitación abierta',
   '(ver Twilio Content Builder: HXfa0a2d7d8a9bf5a86ed1646e8497eb60)',
   'recruitment',
   true,
   'HXfa0a2d7d8a9bf5a86ed1646e8497eb60'),

  ('ar_invite_poetic',
   'AR · Invitación poética',
   '(ver Twilio Content Builder: HX0e091cb0050c957f5d2ebe6096da888b)',
   'recruitment',
   true,
   'HX0e091cb0050c957f5d2ebe6096da888b'),

  ('ar_finalize_signup_direct',
   'AR · Finalizar registro · directo',
   '(ver Twilio Content Builder: HXeb5ece4811d2dce435ffb43b5f8738d0)',
   'onboarding',
   true,
   'HXeb5ece4811d2dce435ffb43b5f8738d0'),

  ('ar_signup_pending_reminder',
   'AR · Recordatorio inscripción pendiente',
   '(ver Twilio Content Builder: HX0d0b07db24fe3f90f8261856c3e37353)',
   'onboarding',
   true,
   'HX0d0b07db24fe3f90f8261856c3e37353'),

  ('ar_finalize_signup_luz',
   'AR · Finalizar registro · Luz',
   '(ver Twilio Content Builder: HX54d66dd603a9fdfd1eb9255128178514)',
   'onboarding',
   true,
   'HX54d66dd603a9fdfd1eb9255128178514'),

  ('ar_vacancy_match_complete',
   'AR · Match vacante · perfil completo',
   '(placeholder — migration 178 insere body e content_sid corretos)',
   'recruitment',
   true,
   'HXa1ff7c9189b625587929c5f19e4e614f'),

  ('ar_vacancy_match_incomplete',
   'AR · Match vacante · perfil incompleto',
   '(placeholder — migration 178 insere body e content_sid corretos)',
   'recruitment',
   true,
   'HXd8cd5071c998317731286be3e5164854')

ON CONFLICT (slug) DO UPDATE
SET content_sid = EXCLUDED.content_sid,
    name = EXCLUDED.name,
    category = EXCLUDED.category,
    is_active = EXCLUDED.is_active;
