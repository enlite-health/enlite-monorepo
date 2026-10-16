-- ROLLBACK da 516 (spec 050 F15). Perde o estado do relatório já gravado; os eventos `tactiq_extension.*` da trilha (append-only) NÃO se apagam,
-- então a CHECK só volta a `tactiq_link.%` se não houver nenhum. A notificação só sai se nenhum evento a usa.
BEGIN;
DROP TABLE IF EXISTS admission_chrome_reports;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admission_events WHERE kind LIKE 'tactiq\_extension.%') THEN
    ALTER TABLE admission_events DROP CONSTRAINT IF EXISTS admission_events_sem_reuniao_so_vinculo;
    ALTER TABLE admission_events ADD CONSTRAINT admission_events_sem_reuniao_so_vinculo CHECK (
      appointment_id IS NOT NULL OR (kind LIKE 'tactiq\_link.%' AND host_email IS NOT NULL));
  END IF;
END $$;
DELETE FROM notification_types WHERE code = 'ADMISSION_TACTIQ_EXTENSION_CHANGED'
  AND NOT EXISTS (SELECT 1 FROM notification_events WHERE type_code = 'ADMISSION_TACTIQ_EXTENSION_CHANGED');
COMMIT;
