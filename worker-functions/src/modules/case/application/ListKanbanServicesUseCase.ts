/**
 * ListKanbanServicesUseCase — agregado do subcard do Kanban de pacientes (fase 8, DX-8.5).
 *
 * Por paciente: `asOf` pelo fuso do PAÍS do paciente (mesma regra da Fase 7 — `operationDateOf`,
 * nunca o relógio do processo) e `cobertas` pela MESMA conta da Fase 7, reusada só por
 * `buildServiceCoverages` (DX-8.3) — esta classe não recalcula vigência nem soma minutos, só
 * agrega o que o leitor devolveu com o `serviceCode`/`liveVacancyId` de cada serviço. `slots`,
 * `workerId` e `applicationId` NÃO saem na resposta (minimização — o board não os mostra).
 */
import type { CountryCode } from '@shared/domain/countryCodes';
import { PatientKanbanServicesReader, type KanbanServicesRows } from '../infrastructure/PatientKanbanServicesReader';
import { operationDateOf, buildServiceCoverages } from './itineraryCoverage';
import { uncoveredDayAlerts, uncoveredDayCount } from '../domain/itineraryAlerts';
import { expandServiceOccurrences, uncoveredWindow } from '../domain/serviceOccurrences';
import type { ServiceReserve } from '../domain/deriveServiceTeam';
import { ServiceTeamReader } from '../infrastructure/ServiceTeamReader';
import { reservesByServiceId, type ServiceReserveReaderPort } from './serviceReserve';
import type { VacancySemaphoreReaderPort } from './vacancySemaphorePort';
import { VacancySemaphoreReader } from '../../matching/infrastructure/VacancySemaphoreReader';
import { corDoSemaforo, piorCor, type CorDoSemaforo } from '../../matching/domain/vacancySemaphore';

export interface KanbanServiceSummary {
  contractedServiceId: string;
  serviceCode: string;
  scheduleHours: number;
  cobertas: number;
  liveVacancyId: string | null;
  /** DX-13.10 → spec 069 (P7): quantos DIAS, nos próximos `UNCOVERED_HORIZON_DAYS`, o serviço tem turno sin cubrir (ausência sem substituto OU faixa sem alocação). Leitura — nada de A muda. */
  uncoveredDays: number;
  /** 056 §9: `null` = serviço sem vaga viva ("sin vacante"). Leitura derivada do quadro C — nada gravado. */
  reserve: ServiceReserve | null;
  /** semaforo-da-vaga F2: `null` = serviço sem vaga viva (mesmo sentido de `reserve: null`) ou `n` não medido. */
  semaphore: KanbanServiceSemaphore | null;
}

/** Semáforo da vaga viva do serviço: `n` do dono (`semaforoContagemSql`) + a cor da tabela do dono (`corDoSemaforo`). */
export interface KanbanServiceSemaphore {
  n: number;
  color: CorDoSemaforo;
}

export interface KanbanPatientServices {
  patientId: string;
  asOf: string;
  /** P1: a pior cor entre os serviços com semáforo; `null` = nenhum serviço com semáforo (nunca "verde"). */
  worstSemaphore: CorDoSemaforo | null;
  services: KanbanServiceSummary[];
}

export interface ListKanbanServicesResult {
  patients: KanbanPatientServices[];
}

export interface KanbanServicesReaderPort {
  readKanbanServices(countries: readonly CountryCode[]): Promise<KanbanServicesRows[]>;
}

const semaphoreOf = (counts: ReadonlyMap<string, number>, vacancyId: string | null): KanbanServiceSemaphore | null => {
  const n = vacancyId === null ? undefined : counts.get(vacancyId);
  return n === undefined ? null : { n, color: corDoSemaforo(n) };
};

export class ListKanbanServicesUseCase {
  constructor(
    private readonly reader: KanbanServicesReaderPort = new PatientKanbanServicesReader(),
    private readonly teamReader: ServiceReserveReaderPort = new ServiceTeamReader(),
    private readonly semaphoreReader: VacancySemaphoreReaderPort = new VacancySemaphoreReader(),
  ) {}

  async execute(countries: readonly CountryCode[], now: Date = new Date()): Promise<ListKanbanServicesResult> {
    const rows = await this.reader.readKanbanServices(countries);

    // Reserva (056 §9): UMA leitura em lote do quadro C, só dos serviços com vaga viva (os demais são `null`).
    const liveServiceIds = rows.flatMap((row) => row.services.filter((s) => s.liveVacancyId !== null).map((s) => s.id));
    const teamRows = await this.teamReader.readMany(liveServiceIds);

    // Semáforo (semaforo-da-vaga F2): UMA leitura em lote do `n` das vagas vivas, fora do laço por paciente/serviço.
    const liveVacancyIds = rows.flatMap((row) => row.services.flatMap((s) => (s.liveVacancyId === null ? [] : [s.liveVacancyId])));
    const counts = await this.semaphoreReader.readMany(liveVacancyIds);

    const patients = rows.map((row) => {
      const asOf = operationDateOf(row.country, now);
      const reserves = reservesByServiceId(teamRows, asOf);
      const coverages = buildServiceCoverages(row, asOf);
      const { from, to } = uncoveredWindow(asOf);
      const occurrences = row.occurrences ? expandServiceOccurrences(row.occurrences.slots, row.occurrences.assignments, row.occurrences.absences, from, to) : [];
      // `buildServiceCoverages` devolve 1 item por serviço, na MESMA ordem de `row.services`
      // (`itineraryCoverage.ts` — `rows.services.map(...)`) — casamento por índice, sem `find`
      // O(n²) nem fallback (achado #4 do gate parcial da Fase 8).
      const services: KanbanServiceSummary[] = coverages.map((coverage, index) => {
        const service = row.services[index];
        const doServico = occurrences.filter((o) => o.serviceId === service.id);
        return {
          contractedServiceId: coverage.contractedServiceId,
          serviceCode: service.serviceCode,
          scheduleHours: coverage.scheduleHours,
          cobertas: coverage.cobertas,
          liveVacancyId: service.liveVacancyId,
          // L2: DIAS, não turnos — dedupe por `date` (2 faixas descobertas no mesmo dia = 1 dia).
          uncoveredDays: uncoveredDayCount(uncoveredDayAlerts(doServico, asOf, { itineraryAssembled: row.assembled === true, patientStatus: row.patientStatus ?? null })),
          reserve: reserves.get(service.id) ?? null,
          semaphore: semaphoreOf(counts, service.liveVacancyId),
        };
      });
      const worstSemaphore = piorCor(services.flatMap((s) => (s.semaphore === null ? [] : [s.semaphore.color])));
      return { patientId: row.patientId, asOf, worstSemaphore, services };
    });

    return { patients };
  }
}
