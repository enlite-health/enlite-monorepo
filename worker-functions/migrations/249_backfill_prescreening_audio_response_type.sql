-- 249_backfill_prescreening_audio_response_type.sql
--
-- Ticket 86ajfm80t (Pre-Screening por áudio). A geração por IA (Gemini) às vezes
-- produziu perguntas com response_type = '{text}' só, desativando o áudio no bot
-- da Talentum ("Esta pregunta solamente puede ser contestada con text"). A EnLite
-- contratou a Talentum justamente para aceitar áudio; nenhum desses '{text}' foi
-- escolha deliberada da recrutadora (a UI sempre nasceu com áudio marcado — a
-- única fonte de só-texto era a IA).
--
-- Este backfill (parte "PASSADO") habilita áudio nas perguntas já persistidas.
-- O "FUTURO" é coberto no código: forceAudio na origem (GeminiVacancyParserService)
-- + normalizePrescreeningResponseType nas fronteiras (save/publish/sync).
--
-- Escopo: APENAS o outbound (job_posting_prescreening_questions). NÃO altera os
-- projetos já publicados AO VIVO na Talentum (decisão do dono: forward + backfill
-- DB; sem republicar, que trocaria whatsappUrl/slug e quebraria links).
--
-- Idempotente: só toca linhas sem 'audio'; array_append preserva 'text' e ordem.

BEGIN;

UPDATE job_posting_prescreening_questions
SET response_type = array_append(response_type, 'audio')
WHERE NOT ('audio' = ANY(response_type));

COMMIT;
