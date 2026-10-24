/**
 * serviceReserve — a reserva da Equipe de Resposta Rápida por serviço (056 §9, D516), montada a partir das
 * linhas do `ServiceTeamReader` e da `asOf` que o chamador já calculou. Leitura pura: delega a
 * `deriveServiceReserve` (domínio), sem nova regra. Serviço ausente do leitor = sem vaga viva = `null`.
 */
import { deriveServiceReserve, type ServiceReserve } from '../domain/deriveServiceTeam';
import type { ServiceTeamRows } from '../infrastructure/ServiceTeamReader';

/** O leitor em lote (porta dos use cases de leitura): uma consulta para todos os serviços. */
export interface ServiceReserveReaderPort {
  readMany(serviceIds: string[]): Promise<ServiceTeamRows[]>;
}

export function reservesByServiceId(rows: readonly ServiceTeamRows[], asOf: string): Map<string, ServiceReserve | null> {
  const result = new Map<string, ServiceReserve | null>();
  for (const row of rows) {
    result.set(
      row.serviceId,
      deriveServiceReserve({
        serviceId: row.serviceId,
        liveVacancyId: row.liveVacancyId,
        asOf,
        candidacies: row.candidacies,
        assignments: row.assignments,
        marks: row.marks,
        substitutions: row.substitutions ?? [],
      }),
    );
  }
  return result;
}
