-- ROLLBACK_502_pt_contact_status_and_reminders.sql — par de rollback da migration 502 (spec 048).
--
-- Mora em `migrations/pending/` (sem número): só roda quando alguém aponta o caminho explicitamente.
--   ./scripts/run-migration-prod.sh worker-functions/migrations/pending/ROLLBACK_502_pt_contact_status_and_reminders.sql
--
-- ATENÇÃO: derrubar apaga o estado "Todavía no hay registro"/"No necesita" de todas as versões e os lembretes
-- pendentes. Reverter o código ANTES (o createVersion grava nestas tabelas; a varredura lê delas).
DELETE FROM iam.group_permissions
 WHERE permission_id IN (SELECT id FROM iam.permissions
                          WHERE resource = 'patient_therapeutic_project' AND action IN ('waive_contact', 'incomplete_alert'));
DELETE FROM iam.permissions
 WHERE resource = 'patient_therapeutic_project' AND action IN ('waive_contact', 'incomplete_alert');
DROP TABLE IF EXISTS patient_tp_contact_reminders;
DROP TABLE IF EXISTS patient_tp_contact_reminder_cycles;
DROP TABLE IF EXISTS patient_therapeutic_project_contact_status;
DROP FUNCTION IF EXISTS fn_ptcr_carimbo_unico();
DROP FUNCTION IF EXISTS fn_ptcrc_country_from_patient();
DROP FUNCTION IF EXISTS fn_ptpcs_imutavel();
DROP FUNCTION IF EXISTS fn_ptpcs_country_from_patient();
-- O tipo de notificação só some se nenhum evento o usa (FK):
DELETE FROM notification_types WHERE code = 'THERAPEUTIC_PROJECT_CONTACTS_PENDING'
  AND NOT EXISTS (SELECT 1 FROM notification_events WHERE type_code = 'THERAPEUTIC_PROJECT_CONTACTS_PENDING');
