/**
 * patientClinicalAccess — o ÚNICO ponto que decide se um ator lê o texto clínico restrito do
 * paciente (hoje: `emergency_instructions`, REQ-01 · D211.2).
 *
 * Decisão humana (Gabriel, 29/08 — D211.2): a coluna NÃO é cifrada; "se ele não puder ler, nós não
 * mostramos". Enquanto o ABAC não chega, quem lê a ficha (todo staff) lê o campo. Quando o engine
 * de permissões passar a montar `req.permissionCells` (família `admin.patients`, célula
 * `patient_clinical:read`), este helper obedece às células SEM mudança de código no resto:
 *   - cells === null  → o engine não decidiu nesta request → comportamento de hoje (D113)
 *   - cells === []    → ator conhecido e sem célula → redige
 *   - cells inclui `patient_clinical:read` → lê
 * O valor NUNCA vai para log; quem quiser trilha de leitura registra só (paciente, ator, quando).
 */
import type { Request } from 'express';

export const PATIENT_CLINICAL_READ_CELL = 'patient_clinical:read';
export const CLINICAL_RESTRICTED_FIELDS = ['emergencyInstructions', 'emergencyInstructionsUpdatedAt', 'emergencyInstructionsUpdatedBy'] as const;

export function canReadPatientClinical(cells: readonly string[] | null | undefined): boolean {
  if (cells === null || cells === undefined) return true; // engine não decidiu → o que a rota devolvia antes
  return cells.includes(PATIENT_CLINICAL_READ_CELL);
}

/** Lê as células que o middleware de permissões (quando enforçado) pendura na request. */
export function clinicalCellsOf(req: Request): readonly string[] | null {
  const cells = (req as Request & { permissionCells?: readonly string[] | null }).permissionCells;
  return cells ?? null;
}

/**
 * Projeta a ficha para o ator: campos restritos viram null + `emergencyInstructionsRedacted: true`.
 * Devolve o MESMO objeto quando o ator pode ler (sem cópia — a ficha é grande).
 */
export function projectPatientClinicalForActor<T extends Record<string, unknown>>(patient: T, cells: readonly string[] | null | undefined): T & { emergencyInstructionsRedacted?: true } {
  if (canReadPatientClinical(cells)) return patient;
  const out: Record<string, unknown> = { ...patient, emergencyInstructionsRedacted: true };
  for (const f of CLINICAL_RESTRICTED_FIELDS) out[f] = null;
  return out as T & { emergencyInstructionsRedacted: true };
}
