-- 244_swap_vacancy_templates_optout_footer.sql
--
-- Aponta os templates de CONVITE DE VAGA pras versões v3 aprovadas no Meta, que
-- trazem o rodapé de opt-out ("_Si no querés recibir más mensajes, respondé BAJA._").
-- Parte do fix do incidente 2026-07-10 (lembretes/convites indo pra quem não quer):
-- o guard no OutboxProcessor honra opt-out no envio; este swap dá à pessoa a
-- instrução VISÍVEL de como sair.
--
-- Rollback (SIDs antigos, sem rodapé):
--   ar_vacancy_match_complete   -> HXbd608e95260a97d1da8f9e21c9eae77a
--   ar_vacancy_match_incomplete -> HX28e3f10dde62eae90999fe1cf9bf23b3
--
-- Idempotente: UPDATE por slug (re-rodar seta o mesmo valor).

BEGIN;

UPDATE message_templates
   SET content_sid = 'HX4c9adc8e0de4593e00b919bdd3313002'
 WHERE slug = 'ar_vacancy_match_complete';

UPDATE message_templates
   SET content_sid = 'HX585a2432b3636b663cff277abd83c488'
 WHERE slug = 'ar_vacancy_match_incomplete';

COMMIT;
