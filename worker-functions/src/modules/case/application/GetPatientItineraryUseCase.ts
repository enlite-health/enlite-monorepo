/**
 * GetPatientItineraryUseCase — fase 7, DX-7.6.
 *
 * Lê o itinerário (`PatientItineraryReader`) e chama `computeServiceCoverage` (fonte única das
 * horas cobertas, `2026-09-23a#REGRA-24`) uma vez por serviço ativo. `asOf` é a data LOCAL da
 * operação do paciente — `localParts(now, countryToTimezone(country))`, nunca `new Intl…` novo
 * nem o relógio UTC do processo — porque a vigência da alocação compara datas por fuso do país,
 * não por instante.
 *
 * Fase 12 (DX-12.5 (4)): cada alocação sai com `allocationId` e `displayName` — o nome só de
 * alocação VIGENTE em `asOf` (`workerIdsToName`), projetado pela fonte única
 * `projectWorkerDisplayNames` (célula `worker_contact:read`, decidida antes do KMS) e pareado por
 * `withAssignmentIdentity` DEPOIS de `buildServiceCoverages` (a conta não muda). `cells === null` =
 * engine OFF (comportamento de hoje: o nome aparece).
 */
import { PatientItineraryReader, type ItineraryRows, type ItineraryAssignmentStatus } from '../infrastructure/PatientItineraryReader';
import { operationDateOf, buildServiceCoverages } from './itineraryCoverage';
import { uncoveredDayAlerts } from '../domain/itineraryAlerts';
import { withAssignmentIdentity, workerIdsToName, type PatientItineraryServiceView } from './itineraryAssignmentView';
import { projectWorkerDisplayNames } from './workerDisplayNames';
import type { ServiceReserve } from '../domain/deriveServiceTeam';
import { ServiceTeamReader } from '../infrastructure/ServiceTeamReader';
import { reservesByServiceId, type ServiceReserveReaderPort } from './serviceReserve';
import { type Decryptor } from '@modules/identity/permissions';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';

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
  durationMinutes: number;
  /** DERIVADO (início + duração). */
  endTime: string;
  assignments: PatientItineraryAssignment[];
}

export interface PatientItineraryService {
  contractedServiceId: string;
  /** `pcs.providers_needed`; `null` = não informada (CAPACITY_NOT_EVALUATED é estado de leitura; nunca "1" — plan §1 P4(b)). */
  providersNeeded: number | null;
  /** Σ durationMinutes/60 das faixas vigentes (spec 056 §6.1). */
  scheduleHours: number;
  cobertas: number;
  slots: PatientItinerarySlot[];
}

/** O serviço da resposta: a cobertura + a reserva da Equipe de Resposta Rápida (056 §9; `null` = sem vaga viva). */
export type PatientItineraryServiceWithReserve = PatientItineraryServiceView & { reserve: ServiceReserve | null };

/** Ausência sem substituto, `date >= asOf` — a mesma regra do Kanban (DX-13.9/13.10). Sem `workerId`/nome. */
export interface PatientItineraryAlert {
  serviceId: string;
  date: string;
  startTime: string;
  endTime: string;
}

export interface PatientItineraryResult {
  patientId: string;
  asOf: string;
  services: PatientItineraryServiceWithReserve[];
  alerts: PatientItineraryAlert[];
  /** `max(assembled_at)` da montagem (ISO UTC) ou `null` se nunca montado (Fase 3, C8). */
  assembledAt: string | null;
}

export interface PatientItineraryReaderPort {
  readPatientItinerary(patientId: string): Promise<ItineraryRows | null>;
}

export class GetPatientItineraryUseCase {
  constructor(
    private readonly reader: PatientItineraryReaderPort = new PatientItineraryReader(),
    private readonly kms: Decryptor = new KMSEncryptionService(),
    private readonly teamReader: ServiceReserveReaderPort = new ServiceTeamReader(),
  ) {}

  async execute(patientId: string, now: Date = new Date(), cells: string[] | null = null): Promise<PatientItineraryResult> {
    const rows = await this.reader.readPatientItinerary(patientId);
    if (rows === null) throw new PatientNotFoundForItineraryError(patientId);

    const asOf = operationDateOf(rows.country, now);
    const coverages = buildServiceCoverages(rows, asOf);
    const displayNameByWorkerId = await projectWorkerDisplayNames(workerIdsToName(rows.slots, coverages, asOf), cells, this.kms);
    const withIdentity = withAssignmentIdentity(coverages, rows.slots, asOf, displayNameByWorkerId);
    const reserves = reservesByServiceId(await this.teamReader.readMany(withIdentity.map((s) => s.contractedServiceId)), asOf);
    const services = withIdentity.map((service) => ({ ...service, reserve: reserves.get(service.contractedServiceId) ?? null }));
    const alerts = uncoveredDayAlerts(rows.uncoveredAbsences ?? [], asOf);

    return { patientId, asOf, services, alerts, assembledAt: rows.assembledAt ?? null };
  }
}
