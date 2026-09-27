/**
 * itineraryCoverage — extração pura da conta da Fase 7 (DX-8.3). `operationDateOf` e
 * `buildServiceCoverages` são movidos SEM mudança de comportamento de
 * `GetPatientItineraryUseCase.ts:57-64,73-126` — nenhuma lógica nova, nenhum import a mais além
 * dos que já existiam ali. `ServiceCoverageCalculator.ts` (a conta) e `PatientItineraryReader.ts`
 * (o leitor) continuam intocados; este arquivo só reagrupa o que já rodava dentro do caso de uso
 * para que a Fase 8 (agregado do Kanban) reuse a mesma conta sem duplicá-la.
 */
import type { ItineraryRows, ItineraryAssignmentStatus } from '../infrastructure/PatientItineraryReader';
import { computeServiceCoverage, type ServiceCoverageSlot } from '../domain/ServiceCoverageCalculator';
import { localParts } from '../../matching/domain/interviewSlotResolver';
import { countryToTimezone } from '@shared/locale/CountryTimezone';
import type { PatientItineraryService, PatientItinerarySlot } from './GetPatientItineraryUseCase';

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** `YYYY-MM-DD` a partir das partes locais (`localParts`) — nunca `Date`/`Intl` direto aqui. */
function toDateString(parts: { year: number; month: number; day: number }): string {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

/** Data LOCAL da operação do paciente (fuso do PAÍS, nunca o relógio do processo). */
export function operationDateOf(country: string, now: Date): string {
  return toDateString(localParts(now, countryToTimezone(country)));
}

/**
 * Agrupamento linhas → serviços → `computeServiceCoverage`, uma vez por serviço ativo, na ordem
 * em que o leitor devolveu as linhas (ORDER BY do SQL) — pré-inicializado para todo serviço
 * ativo, mesmo o que não tem nenhum slot.
 */
export function buildServiceCoverages(
  rows: Pick<ItineraryRows, 'services' | 'slots'>,
  asOf: string,
): PatientItineraryService[] {
  const slotsByService = new Map<string, Map<string, PatientItinerarySlot>>();
  for (const service of rows.services) slotsByService.set(service.id, new Map());

  for (const row of rows.slots) {
    const slotsForService = slotsByService.get(row.contractedServiceId);
    if (!slotsForService) continue; // serviço inativo (o JOIN já filtra, defensivo)
    let slot = slotsForService.get(row.id);
    if (!slot) {
      slot = {
        id: row.id,
        weekday: row.weekday,
        startTime: row.startTime,
        endTime: row.endTime,
        active: row.active,
        assignments: [],
      };
      slotsForService.set(row.id, slot);
    }
    if (row.assignmentId !== null) {
      slot.assignments.push({
        workerId: row.workerId as string,
        applicationId: row.applicationId as string,
        validFrom: row.validFrom as string,
        validTo: row.validTo,
        status: row.status as ItineraryAssignmentStatus,
      });
    }
  }

  return rows.services.map((service) => {
    const slots = Array.from(slotsByService.get(service.id)?.values() ?? []);
    const input: ServiceCoverageSlot[] = slots.map((slot) => ({
      weekday: slot.weekday,
      startTime: slot.startTime,
      endTime: slot.endTime,
      active: slot.active,
      assignments: slot.assignments,
    }));
    const coverage = computeServiceCoverage({
      contractedHours: { weekly: service.weeklyHours, authorized: service.authorizedHours },
      slots: input,
      asOf,
    });
    return {
      contractedServiceId: service.id,
      contratadas: coverage.contratadas,
      cobertas: coverage.cobertas,
      slots,
    };
  });
}
