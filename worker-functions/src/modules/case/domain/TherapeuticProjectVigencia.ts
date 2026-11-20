/**
 * PTI vigente POR SERVIÇO CONTRATADO E DATA (spec 092, decisão do orquestrador na F-0-c; DC-2/DC-4).
 *
 * `currentVersionOf` (TherapeuticProject.ts) é POR PACIENTE e não olha serviço nem prazo: devolveria o PTI de outro serviço. Esta regra é
 * a que o informe da guarda precisa:
 *
 *   vigente(S, D) = versões com `contractedServiceId = S`, NÃO anuladas, com `startDate <= D <= endDate`;
 *                   empate → a de `createdAt` mais recente (a mesma regra da D328 para "versão atual" — reusa `currentVersionOf`).
 *   Nenhuma → `null` (DC-4: informe só com narrativa, `pti_version_id = NULL`).
 *
 * Datas civis `YYYY-MM-DD` comparam por texto (ordem lexicográfica = cronológica). Pura. NÃO altera `currentVersionOf` nem os chamadores dele.
 */
import { currentVersionOf } from './TherapeuticProject';

export interface ProjectVersionInForce {
  id: string;
  contractedServiceId: string;
  /** Data civil `YYYY-MM-DD`, inclusive. */
  startDate: string;
  /** Data civil `YYYY-MM-DD`, inclusive. */
  endDate: string;
  createdAt: string;
  annulledAt: string | null;
}

export function projectInForceFor<T extends ProjectVersionInForce>(
  versions: readonly T[],
  contractedServiceId: string,
  onDate: string,
): T | null {
  const candidates = versions.filter(
    (v) => v.contractedServiceId === contractedServiceId && v.startDate <= onDate && onDate <= v.endDate,
  );
  return currentVersionOf(candidates);
}
