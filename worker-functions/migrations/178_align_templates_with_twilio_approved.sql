-- ============================================================
-- Migration 178: Alinha templates de mensagem com os aprovados no Twilio/Meta
--
-- Contexto: Os templates vacancy_match_* (ar_vacancy_match_complete e
-- ar_vacancy_match_incomplete) foram aprovados pela Meta em 2026-05-20 com
-- content_sids definitivos. Os slugs do sprint (vacancy_invited_auto) são
-- substituídos pelos 2 novos slugs aprovados.
--
-- Também atualiza complete_register_ofc com o content_sid aprovado.
-- ============================================================

-- Insere os 2 novos templates aprovados Twilio (ar_vacancy_match_*)
INSERT INTO message_templates (slug, name, body, category, is_active, content_sid)
VALUES (
  'ar_vacancy_match_complete',
  'Convite automático pós-match (worker com cadastro completo)',
  '¡Hola {{worker_name}}! Soy Luz, de EnLite Health.\n\nLlegó una nueva oportunidad cerca tuyo, en {{patient_zone}}. Tu perfil coincide con lo que está buscando esta persona.\n\nMirá los detalles e inscribite a la entrevista acá: {{vacancy_url}}.\n\n¡Vamos a iluminar esta historia juntos!',
  'auto_invite',
  true,
  'HXa1ff7c9189b625587929c5f19e4e614f'
),
(
  'ar_vacancy_match_incomplete',
  'Convite automático pós-match (worker com cadastro incompleto)',
  '¡Hola {{worker_name}}! Soy Luz, de EnLite Health.\n\nLlegó una oportunidad cerca tuyo, en {{patient_zone}}. Para postularte, todavía necesitamos: {{pending_documents}}.\n\nEntrá a https://app.enlite.health, completá tu perfil y postulate acá: {{vacancy_url}}.\n\nSi tenés dudas, estoy del otro lado.',
  'auto_invite',
  true,
  'HXd8cd5071c998317731286be3e5164854'
)
ON CONFLICT (slug) DO UPDATE
  SET content_sid  = EXCLUDED.content_sid,
      body         = EXCLUDED.body,
      is_active    = true,
      updated_at   = NOW();

-- Atualiza content_sid do template já existente complete_register_ofc
UPDATE message_templates
SET content_sid  = 'HXf7a25b327e14989f78e6d6d4572debc0',
    updated_at   = NOW()
WHERE slug = 'complete_register_ofc';

-- Desativa o slug vacancy_invited_auto (criado na migration 174) — substituído pelos 2 novos acima
UPDATE message_templates
SET is_active  = false,
    updated_at = NOW()
WHERE slug = 'vacancy_invited_auto';
