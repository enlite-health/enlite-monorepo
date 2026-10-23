/**
 * ListKanbanServicesUseCase — agregado do subcard do Kanban de pacientes (fase 8, DX-8.5).
 *
 * Por paciente: `asOf` pelo fuso do PAÍS do paciente (mesma regra da Fase 7 — `operationDateOf`,
 * nunca o relógio do processo) e `cobertas` pela MESMA conta da Fase 7, reusada só por
 * `buildServiceCoverages` (DX-8.3) — esta classe não recalcula vigência nem soma minutos, só
 * agrega o que o leitor devolveu com o `serviceCode`/`liveVacancyId` de cada serviço. `slots`,
 * `workerId` e `applicationId` NÃO saem na resposta (minimização — o board não os mostra).
 */
import { PatientKanbanServicesReader, type KanbanServicesRows } from '../infrastructure/PatientKanbanServicesReader';
import { operationDateOf, buildServiceCoverages } from './itineraryCoverage';
import { uncoveredDayAlerts, uncoveredDayCount } from '../domain/itineraryAlerts';
import { expandServiceOccurrences, uncoveredWindow } from '../domain/serviceOccurrences';
import type { ServiceReserve } from '../domain/deriveServiceTeam';
import { ServiceTeamReader } from '../infrastructure/ServiceTeamReader';
import { reservesByServiceId, type ServiceReserveReaderPort } from './serviceReserve';

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
}

export interface KanbanPatientServices {
  patientId: string;
  asOf: string;
  services: KanbanServiceSummary[];
}

export interface ListKanbanServicesResult {
  patients: KanbanPatientServices[];
}

export interface KanbanServicesReaderPort {
  readKanbanServices(country: 'AR' | 'BR' | null): Promise<KanbanServicesRows[]>;
}

export class ListKanbanServicesUseCase {
  constructor(
    private readonly reader: KanbanServicesReaderPort = new PatientKanbanServicesReader(),
    private readonly teamReader: ServiceReserveReaderPort = new ServiceTeamReader(),
  ) {}

  async execute(country: 'AR' | 'BR' | null, now: Date = new Date()): Promise<ListKanbanServicesResult> {
    const rows = await this.reader.readKanbanServices(country);

    // Reserva (056 §9): UMA leitura em lote do quadro C, só dos serviços com vaga viva (os demais são `null`).
    const liveServiceIds = rows.flatMap((row) => row.services.filter((s) => s.liveVacancyId !== null).map((s) => s.id));
    const teamRows = await this.teamReader.readMany(liveServiceIds);

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
          uncoveredDays: uncoveredDayCount(uncoveredDayAlerts(doServico, asOf, row.assembled === true)),
          reserve: reserves.get(service.id) ?? null,
        };
      });
      return { patientId: row.patientId, asOf, services };
    });

    return { patients };
  }
}
