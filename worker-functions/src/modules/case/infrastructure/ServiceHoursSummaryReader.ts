/**
 * ServiceHoursSummaryReader — horas/semana (total e cobertas) dos serviços contratados COM vaga
 * viva, para a Gestão à Vista e os casos armados (spec 056 §8). Não tem soma própria: reusa
 * `PatientKanbanServicesReader` (a mesma junção de vaga viva e de faixas vigentes do Kanban) e
 * `buildServiceCoverages` → `computeServiceCoverage` (a única definição de total/cobertas).
 * Vaga legada sem serviço fica fora das horas (⚑14). Paciente `is_test` fica fora, como na antiga `horasAtivasQuery`.
 */
import type { CountryCode } from '@shared/domain/countryCodes';
import { inPatientTransaction } from '../application/patientTransaction';
import { PatientKanbanServicesReader, type KanbanServicesRows } from './PatientKanbanServicesReader';
import { buildServiceCoverages, operationDateOf } from '../application/itineraryCoverage';
import type {
  ServiceHoursSummary,
  ServiceHoursSummaryPort,
} from '../../matching/application/ServiceHoursSummaryPort';

export interface KanbanRowsReader {
  readKanbanServices(country: 'AR' | 'BR' | null): Promise<KanbanServicesRows[]>;
}

/** Ids dos pacientes de teste dos países (mesmo predicado da antiga `horasAtivasQuery`). */
export type TestPatientIdsReader = (countries: CountryCode[]) => Promise<Set<string>>;

/** Leitura própria (não altera o Kanban): `COALESCE(p.is_test, false) = false` negado, com a mesma RLS de país. */
export const readTestPatientIds: TestPatientIdsReader = async (countries) => {
  if (countries.length === 0) return new Set();
  const ids = await inPatientTransaction(async (client) => {
    const res = await client.query<{ id: string }>(
      `SELECT p.id FROM patients p
        WHERE p.deleted_at IS NULL AND COALESCE(p.is_test, false) = true
          AND p.country = ANY($1::bpchar[])`,
      [countries],
    );
    return res.rows.map((r) => r.id);
  });
  return new Set(ids);
};

export class ServiceHoursSummaryReader implements ServiceHoursSummaryPort {
  constructor(
    private readonly reader: KanbanRowsReader = new PatientKanbanServicesReader(),
    private readonly testPatientIds: TestPatientIdsReader = readTestPatientIds,
  ) {}

  async readServiceHours(countries: CountryCode[], now: Date = new Date()): Promise<ServiceHoursSummary> {
    const summary: ServiceHoursSummary = {
      total: 0,
      cobertas: 0,
      servicesWithSchedule: 0,
      servicesWithoutSchedule: 0,
    };

    const testIds = await this.testPatientIds(countries);
    for (const country of countries) {
      const rows = await this.reader.readKanbanServices(country);
      for (const row of rows) {
        if (testIds.has(row.patientId)) continue; // paciente de teste fora das métricas
        const asOf = operationDateOf(row.country, now);
        // 1 item por serviço, na mesma ordem de `row.services` (contrato de buildServiceCoverages).
        const coverages = buildServiceCoverages(row, asOf);
        coverages.forEach((coverage, index) => {
          if (row.services[index].liveVacancyId === null) return;
          summary.total += coverage.scheduleHours;
          summary.cobertas += coverage.cobertas;
          if (coverage.slots.length > 0) summary.servicesWithSchedule += 1;
          else summary.servicesWithoutSchedule += 1;
        });
      }
    }
    return summary;
  }
}
