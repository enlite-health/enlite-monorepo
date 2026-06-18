-- ============================================================
-- Migration 211: Troca content_sid dos templates de match de vaga pelos _v2
--
-- ⚠️  NÃO APLICAR até a Meta APROVAR os dois templates _v2.
--     Content do Twilio é imutável; pra corrigir o link quebrado (ponto colado
--     no fim da URL) foram criados Content novos com body corrigido:
--       ar_vacancy_match_complete_v2   -> HXbd608e95260a97d1da8f9e21c9eae77a
--       ar_vacancy_match_incomplete_v2 -> HX28e3f10dde62eae90999fe1cf9bf23b3
--     Os antigos (HXa1ff…/HXd8cd…) seguem ativos e aprovados — NÃO deletar até
--     esta migration rodar e os envios serem validados com os SIDs novos.
--
--     Conferir aprovação antes de aplicar:
--       curl -s -u "$SID:$TOK" \
--         https://content.twilio.com/v1/Content/HXbd608e95260a97d1da8f9e21c9eae77a/ApprovalRequests
--       (whatsapp.status precisa ser "approved" nos dois)
--
-- O slug é a chave usada pelo envio automático (VacancyAutoInviteHandler ->
-- outbox.template_slug -> findBySlug -> content_sid); por isso o slug NÃO muda,
-- só o content_sid. O body já foi corrigido na migration 210 (espelho Chatwoot).
-- ============================================================

UPDATE message_templates
SET content_sid = 'HXbd608e95260a97d1da8f9e21c9eae77a',
    updated_at  = NOW()
WHERE slug = 'ar_vacancy_match_complete';

UPDATE message_templates
SET content_sid = 'HX28e3f10dde62eae90999fe1cf9bf23b3',
    updated_at  = NOW()
WHERE slug = 'ar_vacancy_match_incomplete';
