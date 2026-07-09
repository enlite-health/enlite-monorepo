-- Migration 239: canal de mensageria por worker (fundação do roteamento Twilio → Periskope)
--
-- CONTEXTO: worker frio recebe WhatsApp via Twilio (WABA oficial). Após handover
-- (1º texto livre não-roteável), todo o tráfego daquele worker passa a ser
-- servido pelo provider Periskope (WhatsApp Web). messaging_channel é a coluna
-- que decide, por worker, qual provider concreto o RoutingMessagingService usa.
--
-- Seguro em relação aos triggers existentes de workers: fn_guard_registered_status
-- (mig 111/208) e o trigger de status history (mig 096) disparam em
-- `UPDATE OF status` — um UPDATE que só toca messaging_channel não os aciona.
--
-- Idempotente: IF NOT EXISTS em todas as DDLs.

ALTER TABLE workers
  ADD COLUMN IF NOT EXISTS messaging_channel VARCHAR(20) NOT NULL DEFAULT 'twilio';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workers_messaging_channel_check'
  ) THEN
    ALTER TABLE workers
      ADD CONSTRAINT workers_messaging_channel_check
      CHECK (messaging_channel IN ('twilio', 'periskope'));
  END IF;
END;
$$;

COMMENT ON COLUMN workers.messaging_channel IS
  'Provider de WhatsApp atualmente responsável por este worker: twilio (WABA oficial, '
  'default) ou periskope (WhatsApp Web, pós-handover). Flipado por '
  'TriggerWorkerHandoverUseCase quando o worker envia o 1º texto livre não-roteável. '
  'Lido por RoutingMessagingService/OutboxProcessor para decidir o canal de envio.';
