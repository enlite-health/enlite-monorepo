/**
 * GetPatientItineraryUseCase — fase 7, DX-7.6.
 *
 * Lê o itinerário (`PatientItineraryReader`) e chama `computeServiceCoverage` (fonte única das
 * horas cobertas, `2026-09-23a#REGRA-24`) uma vez por serviço ativo. `asOf` é a data LOCAL da
 * operação do paciente — `localParts(now, countryToTimezone(country))`, nunca `new Intl…` novo
 * nem o relógio UTC do processo — porque a vigência da alocação compara datas por fuso do país,
 * não por instante.
 */
import { PatientItineraryReader, type ItineraryRows, type ItineraryAssignmentStatus } from '../infrastructure/PatientItineraryReader';
import { computeServiceCoverage, type ServiceCoverageSlot } from '../domain/ServiceCoverageCalculator';
import { localParts } from '../../matching/domain/interviewSlotResolver';
import { countryToTimezone } from '@shared/locale/CountryTimezone';

/** Reader devolveu `null` (paciente inexistente/soft-deletado/outro país). O controller mapeia para 404. */
export class PatientNotFoundForItineraryError extends Error {
  constructor(readonly patientId: string) {
    super(`Patient not found: ${patientId}`);
    this.name = 'PatientNotFoundForItineraryError';
  }
}

export interface PatientItineraryAssignment {
  workerId: string;
  applicationId: string;
  validFrom: string;
  validTo: string | null;
  status: ItineraryAssignmentStatus;
}

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

export interface PatientItineraryResult {
  patientId: string;
  asOf: string;
  services: PatientItineraryService[];
}

export interface PatientItineraryReaderPort {
  readPatientItinerary(patientId: string): Promise<ItineraryRows | null>;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** `YYYY-MM-DD` a partir das partes locais (`localParts`) — nunca `Date`/`Intl` direto aqui. */
function toDateString(parts: { year: number; month: number; day: number }): string {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

export class GetPatientItineraryUseCase {
  constructor(private readonly reader: PatientItineraryReaderPort = new PatientItineraryReader()) {}

  async execute(patientId: string, now: Date = new Date()): Promise<PatientItineraryResult> {
    const rows = await this.reader.readPatientItinerary(patientId);
    if (rows === null) throw new PatientNotFoundForItineraryError(patientId);

    const asOf = toDateString(localParts(now, countryToTimezone(rows.country)));

    // Um mapa de slots por serviço, na ordem em que o leitor devolveu as linhas (ORDER BY do
    // SQL) — pré-inicializado para todo serviço ativo, mesmo o que não tem nenhum slot.
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

    const services: PatientItineraryService[] = rows.services.map((service) => {
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

    return { patientId, asOf, services };
  }
}
