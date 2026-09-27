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

export interface KanbanServiceSummary {
  contractedServiceId: string;
  serviceCode: string;
  contratadas: { weekly: number | null; authorized: number | null };
  cobertas: number;
  liveVacancyId: string | null;
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
  constructor(private readonly reader: KanbanServicesReaderPort = new PatientKanbanServicesReader()) {}

  async execute(country: 'AR' | 'BR' | null, now: Date = new Date()): Promise<ListKanbanServicesResult> {
    const rows = await this.reader.readKanbanServices(country);

    const patients = rows.map((row) => {
      const asOf = operationDateOf(row.country, now);
      const coverages = buildServiceCoverages(row, asOf);
      const services: KanbanServiceSummary[] = coverages.map((coverage) => {
        const service = row.services.find((s) => s.id === coverage.contractedServiceId);
        return {
          contractedServiceId: coverage.contractedServiceId,
          serviceCode: service?.serviceCode ?? '',
          contratadas: coverage.contratadas,
          cobertas: coverage.cobertas,
          liveVacancyId: service?.liveVacancyId ?? null,
        };
      });
      return { patientId: row.patientId, asOf, services };
    });

    return { patients };
  }
}
