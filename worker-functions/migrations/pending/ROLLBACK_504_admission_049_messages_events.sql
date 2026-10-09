-- ROLLBACK_504_admission_049_messages_events.sql — par de rollback da migration 504 (spec 049).
-- ATENÇÃO: apaga a trilha e o registro de mensagens. Reverter o código ANTES (o envio faz o claim nestas tabelas).
DROP TABLE IF EXISTS admission_messages;
-- O trigger de imutabilidade bloqueia DELETE, mas DROP TABLE não o dispara.
DROP TABLE IF EXISTS admission_events;
DROP FUNCTION IF EXISTS fn_admission_events_imutavel();
