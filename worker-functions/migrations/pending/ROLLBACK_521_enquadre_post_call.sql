-- ROLLBACK_521_enquadre_post_call.sql — par de rollback da migration 521 (spec 052, Fase 3).
-- Mora em `migrations/pending/`; só roda quando alguém aponta o caminho. PERDE a trilha, os documentos de resumo (linhas; os objetos
-- no bucket ficam órfãos), a presença medida e o estado da importação gravado nas colunas novas. Antes:
--   SELECT count(*) FROM enquadre_event_trail; SELECT count(*) FROM enquadre_event_documents;
-- A 521 reaplica limpo depois deste rollback (idempotente).
BEGIN;
DROP TABLE IF EXISTS enquadre_event_documents;
DROP TABLE IF EXISTS enquadre_event_trail;
DROP FUNCTION IF EXISTS fn_enquadre_event_trail_imutavel();
ALTER TABLE enquadre_event_participants
  DROP CONSTRAINT IF EXISTS enquadre_participants_match_method_check,
  DROP CONSTRAINT IF EXISTS enquadre_participants_attendance_check,
  DROP COLUMN IF EXISTS match_method,
  DROP COLUMN IF EXISTS attendance;
ALTER TABLE enquadre_events
  DROP CONSTRAINT IF EXISTS enquadre_events_blocked_reason_check,
  DROP CONSTRAINT IF EXISTS enquadre_events_transcript_pair,
  DROP COLUMN IF EXISTS blocked_reason,
  DROP COLUMN IF EXISTS transcript_sha256,
  DROP COLUMN IF EXISTS transcript_object_path,
  DROP COLUMN IF EXISTS conference_started_at;
COMMIT;
