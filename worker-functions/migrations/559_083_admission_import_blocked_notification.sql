-- 559 — Importação do Tactiq bloqueada que só uma pessoa resolve (spec 083, Fase 3): tipo de notificação do sino.
--
-- ADMISSION_IMPORT_BLOCKED: aviso automático ao responsável da reunião (bloqueou / lembrete / expirou) e à gestão (vai perder a
-- gravação). Payload fechado, sem dado de paciente (ver SystemNotificationPublisher.buildAdmissionImportBlockedPayload).
--
-- ORDEM DE ROLLOUT (merge = deploy): aplicar em prd ANTES do merge. Sem este tipo o INSERT do sino falha DENTRO da transação do
-- bloqueio e o `blocked` desfaz a cada rodada do job.
--
-- Idempotente (2×). ROLLBACK: migrations/pending/ROLLBACK_559_083_admission_import_blocked_notification.sql

BEGIN;

INSERT INTO notification_types (code, description) VALUES
  ('ADMISSION_IMPORT_BLOCKED',
   'Aviso automático: a transcrição de uma reunião não pôde ser importada porque o Tactiq do responsável não está vinculado (ou é de outra conta); lembretes e aviso de perda à gestão')
ON CONFLICT (code) DO NOTHING;

COMMIT;
