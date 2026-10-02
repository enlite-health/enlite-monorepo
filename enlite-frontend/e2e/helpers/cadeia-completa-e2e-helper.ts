/**
 * cadeia-completa-e2e-helper.ts — porte MÍNIMO da stage (D469): só `lastStatusChangeSource`,
 * usada por funil-vacante-lancamento-rascunho. O helper completo da cadeia (Fase 16) só existe na stage.
 */
import { runSQL } from './patient-detail-a-helper';

/** `change_source` da ÚLTIMA linha de `patient_status_history` do paciente ('' se nenhuma). */
export function lastStatusChangeSource(patientId: string): string {
  return runSQL(
    `SELECT change_source FROM patient_status_history WHERE patient_id = '${patientId}' ORDER BY created_at DESC, id DESC LIMIT 1`,
  );
}
