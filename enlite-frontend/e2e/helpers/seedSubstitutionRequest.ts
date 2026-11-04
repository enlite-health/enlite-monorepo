/**
 * Semente de PEDIDO de substituição (spec 069, migration 548) — par do helper de `worker-functions/tests/e2e/helpers/seedSubstitutionRequest.ts`,
 * em SQL de texto para o `runSQL`/`sqlComVars` dos e2e de tela. Desde a 548 o INSERT de `patient_itinerary_absence` por SQL direto
 * exige `request_id`: o pedido existe, não está desfeito e é do MESMO serviço e do MESMO titular da alocação.
 *
 * O cabeçalho é gravado num statement PRÓPRIO, antes da ausência (um CTE não serve: o gatilho da ausência não enxerga o INSERT do mesmo comando).
 * `reasonCode` default `OTHER` (catálogo `service_exit_reasons`, ativo desde a 492).
 */
import { runSQL } from './patient-detail-a-helper';
import { extractUuid } from './itinerario-escrita-e2e-helper';

export function seedRequestForAssignment(assignmentId: string, createdBy = 'e2e', reasonCode = 'OTHER'): string {
  return extractUuid(
    runSQL(
      `INSERT INTO patient_itinerary_substitution_request (contracted_service_id, outgoing_worker_id, reason_code, created_by) ` +
        `SELECT s.contracted_service_id, a.worker_id, '${reasonCode}', '${createdBy}' ` +
        `FROM patient_itinerary_assignment a JOIN patient_itinerary_slot s ON s.id = a.slot_id ` +
        `WHERE a.id = '${assignmentId}' RETURNING id`,
    ),
  );
}

/** Apaga os pedidos dos serviços do paciente — DEPOIS das ausências/alocações/registro (FKs sem cascata para workers). */
export function cleanupRequestsOfPatientSql(patientId: string): string {
  return (
    `DELETE FROM patient_itinerary_substitution_request WHERE contracted_service_id IN (` +
    `SELECT id FROM patient_contracted_services WHERE patient_id = '${patientId}')`
  );
}
