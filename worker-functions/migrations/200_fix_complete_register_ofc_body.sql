-- ============================================================
-- Migration 200: Corrige o body placeholder de complete_register_ofc
--
-- Bug (cross-repo): a migration 063 setou o body deste template como
--   '[Template aprovado Twilio — conteúdo gerenciado via Content API]'
-- sob a premissa de que "o body não é enviado quando há content_sid".
-- Isso é verdade SÓ pro envio (Twilio usa o Content API).
--
-- Mas o body AINDA é usado pelo espelho do Chatwoot:
--   TwilioMessagingService.renderForChatwoot() interpola o body e o
--   ChatwootClient.mirrorOutgoingMessage() posta esse texto na conversa.
-- Resultado: a conversa no Chatwoot recebia o placeholder como mensagem
-- outgoing. Quando o worker respondia, o triage-service (Luz) lia esse
-- placeholder como "o que a Luz disse" e, sem o texto real do outreach,
-- respondia como se fosse o primeiro contato — em vez de continuar a
-- conversa iniciada pelo template.
--
-- Fix: body passa a conter o TEXTO REAL do Content Template aprovado
-- (content_sid HXf7a25b327e14989f78e6d6d4572debc0), copiado verbatim do
-- Twilio Content API. Este template não tem variáveis (variables: {}),
-- então o body é estático — mapToContentVariables() continua retornando
-- {} e o caminho de envio fica IDÊNTICO (zero risco).
--
-- Lição: body e content_sid devem andar juntos. Ao repointar o content_sid
-- (ex.: Passo 2c do incidente — trocar para complete_register_utility
-- quando o Meta aprovar), a MESMA migration DEVE atualizar o body.
-- ============================================================

UPDATE message_templates
SET body = $body$¡Hola! Soy Luz, la asistente virtual de EnLite Health Solutions.
¿Cómo estás? Espero que andes muy bien.

Tenés un registro como profesional de cuidado humano en EnLite y tenemos decenas de búsquedas diarias que según nuestro análisis pueden encajar con tu perfil.

¿Podes actualizar tus datos en nuestro portal?
Es solo ingresar a https://app.enlite.health, completes tu perfil con tu documentación básica para empezar a recibir las notificaciones personalizadas de las búsquedas más adecuadas para vos.

Te invito también a conocer los beneficios para nuestros prestadores: https://jobs.enlite.health/es/beneficios/

Sumate a nuestra comunidad: https://chat.whatsapp.com/Dmx1Pntou8L6OLOQDCmEsT

Y si querés ver todas las búsquedas diariamente, ingreses en nuestra web! Serás muy bienvenida(o).

Como Acompañante Terapéutico, podés transformar vidas. EnLite es más que un servicio, es un gesto de humanidad.

¿Ya estás lista para empezar? 😁💖$body$,
    updated_at = NOW()
WHERE slug = 'complete_register_ofc';
