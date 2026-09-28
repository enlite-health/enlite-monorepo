/**
 * Itinerário do paciente (Fase 12, DX-12.6) — espelho do contrato publicado de
 * `GET /api/admin/patients/:id/itinerary` (`CASE/interfaces/validators/itinerarySchemas.ts`) e do
 * corpo do 409 `ITINERARY_OVERLAP` (`AdminItineraryWriteController.ts`). Datas em `YYYY-MM-DD`
 * (string, nunca `Date`); `asOf` é a data de operação calculada pela API — o front nunca lê o relógio.
 */

export type PatientItineraryAssignmentStatus = 'ACTIVE' | 'ENDED' | 'CANCELLED';

/** Uma alocação do slot. `displayName` vem `null` fora de vigência ou sem a célula de nome do prestador. */
export interface PatientItineraryAssignment {
  workerId: string;
  applicationId: string;
  validFrom: string;
  validTo: string | null;
  status: PatientItineraryAssignmentStatus;
  allocationId: string;
  displayName: string | null;
}

/** Uma faixa semanal do serviço (`weekday` 0 = domingo … 6 = sábado). */
export interface PatientItinerarySlot {
  id: string;
  weekday: number;
  startTime: string;
  endTime: string;
  active: boolean;
  assignments: PatientItineraryAssignment[];
}

export interface PatientItineraryService {
  contractedServiceId: string;
  contratadas: { weekly: number | null; authorized: number | null };
  cobertas: number;
  slots: PatientItinerarySlot[];
}

/** Ausência sem substituto a partir de `asOf` (Fase 13) — sem `workerId` nem nome. */
export interface PatientItineraryAlert {
  serviceId: string;
  date: string;
  startTime: string;
  endTime: string;
}

export interface PatientItinerary {
  patientId: string;
  asOf: string;
  services: PatientItineraryService[];
  alerts: PatientItineraryAlert[];
}

/** Um lado do conflito do 409 — só ids de serviço, dia e horário (nada de nome/endereço). */
export interface ItineraryOverlapSide {
  serviceId: string;
  weekday: number;
  startTime: string;
  endTime: string;
}

/** O detalhe do 409 `ITINERARY_OVERLAP`: `minGapMinutes` vem SEMPRE da API (a folga mora no SQL). */
export interface ItineraryOverlapDetail {
  existing: ItineraryOverlapSide;
  requested: ItineraryOverlapSide;
  sameAddress: boolean;
  minGapMinutes: number | null;
}

/**
 * Vigente: ACTIVE e `asOf` dentro de `[validFrom, validTo]` (`validTo` inclusivo). Comparação de
 * string `YYYY-MM-DD`, `asOf` da API. Espelho declarado do dono no backend:
 * `worker-functions/src/modules/case/domain/ServiceCoverageCalculator.ts` (`isVigente`) — mudou lá,
 * muda aqui (DX-12.11).
 */
export function isVigenteAt(assignment: PatientItineraryAssignment, asOf: string): boolean {
  return (
    assignment.status === 'ACTIVE' &&
    assignment.validFrom <= asOf &&
    (assignment.validTo === null || assignment.validTo >= asOf)
  );
}

/** "cobertas/contratadas" do serviço — `—` quando o serviço não tem horas semanais contratadas. */
export function coverageHoursPair(cobertas: number, weekly: number | null): string {
  return `${cobertas}/${weekly ?? '—'}`;
}
