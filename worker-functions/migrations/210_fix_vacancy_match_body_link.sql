-- ============================================================
-- Migration 210: Conserta o link quebrado nos templates de match de vaga
--
-- Bug (evidência prod, conv real): o worker recebia/via o link como
--   https://app.enlite.health/vacancies/<id>.
-- com PONTO colado no fim. No autolink (WhatsApp/Chatwoot) o `.` entra na
-- URL -> 404 / página em branco. Dois defeitos no body da migration 178:
--
--   1. `{{vacancy_url}}.` -> ponto encostado na variável da URL.
--   2. `\n` LITERAL: na 178 o body usou aspas simples normais, e o Postgres
--      (standard_conforming_strings=on) NÃO interpreta `\n` -> gravou barra-n
--      literal. Sem quebra de linha real depois do `.`, o parser nem solta o
--      ponto. Esta migration usa E'...' pra gravar quebras de linha reais.
--
-- O body destes 2 slugs tem content_sid (Twilio), então este texto alimenta
-- (a) o mapeamento de variáveis e (b) o ESPELHO no Chatwoot. A mensagem que o
-- worker recebe no WhatsApp vem do template aprovado no Twilio/Meta — esse
-- precisa ser corrigido no Twilio Console + re-aprovado pela Meta (fora do SQL).
--
-- A ordem das variáveis no body é preservada (mapToContentVariables mapeia
-- named->posicional por ordem de aparição), então os content_sids continuam válidos.
-- ============================================================

UPDATE message_templates
SET body = E'¡Hola {{worker_name}}! Soy Luz, de EnLite Health.\n\nLlegó una nueva oportunidad cerca tuyo, en {{patient_zone}}. Tu perfil coincide con lo que está buscando esta persona.\n\nMirá los detalles e inscribite a la entrevista acá:\n{{vacancy_url}}\n\n¡Vamos a iluminar esta historia juntos!',
    updated_at = NOW()
WHERE slug = 'ar_vacancy_match_complete';

UPDATE message_templates
SET body = E'¡Hola {{worker_name}}! Soy Luz, de EnLite Health.\n\nLlegó una oportunidad cerca tuyo, en {{patient_zone}}. Para postularte, todavía necesitamos: {{pending_documents}}.\n\nEntrá a https://app.enlite.health para completar tu perfil, y postulate acá:\n{{vacancy_url}}\n\nSi tenés dudas, estoy del otro lado.',
    updated_at = NOW()
WHERE slug = 'ar_vacancy_match_incomplete';
