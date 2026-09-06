-- 296_stage_skip_reason_slot_mismatch.sql
--
-- Razão nova de pulo: TEMPLATE_SLOT_MISMATCH.
--
-- Ela existe separada de TEMPLATE_NOT_ALLOWED porque é a ÚNICA que pode aparecer
-- depois de a etapa já estar ligada e funcionando: basta o corpo aprovado na Meta
-- chegar em `message_templates.body_twilio` (pelo sync ou por alguém abrir o
-- painel) e o sistema descobrir que o template pede mais variáveis do que ele
-- sabe preencher. Confundida com "nunca foi permitido", uma etapa pararia de
-- mandar mensagem sem ninguém conseguir distinguir de "não configurada".
--
-- ⚠️ Este CHECK e a união `StageSkipReason` (StageMessageHandler.ts) são a MESMA
-- lista em dois lugares. O teste `tests/e2e/funnel-stage-skip-reasons.e2e.test.ts`
-- insere TODAS as razões da união contra este banco: acrescentar razão sem
-- acrescentar aqui passa a falhar em teste, não em produção.

ALTER TABLE funnel_stage_message_log DROP CONSTRAINT IF EXISTS funnel_stage_message_log_skip_reason_check;

ALTER TABLE funnel_stage_message_log ADD CONSTRAINT funnel_stage_message_log_skip_reason_check
  CHECK (skip_reason IS NULL OR skip_reason IN (
    'DISABLED', 'NO_TEMPLATE', 'TEMPLATE_INACTIVE', 'TEMPLATE_NOT_ALLOWED', 'TEMPLATE_SLOT_MISMATCH',
    'WORKER_NOT_FOUND', 'WORKER_DISABLED', 'OPT_OUT', 'ALREADY_SENT', 'VACANCY_NOT_FOUND',
    'SOURCE_NOT_HUMAN', 'COUNTRY_BLOCKED'
  ));
