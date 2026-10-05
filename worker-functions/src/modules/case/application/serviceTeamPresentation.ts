/**
 * serviceTeamPresentation — quadro C (Servicio Contratado), Fase 10, gate parcial #4/#5.
 *
 * Módulo único para a projeção de nomes e a montagem do `GetServiceTeamResult` — antes duplicadas
 * (~50 linhas idênticas, achado #4 do gate) em `GetServiceTeamUseCase.projectDisplayNames`/montagem
 * do `execute` e em `ServiceTeamMarkUseCase.projectDisplayNames`/montagem do `recompute`. Os dois
 * casos de uso agora só chamam `projectServiceTeamDisplayNames` + `buildServiceTeamResult`.
 *
 * Achado #5: a projeção decifra SÓ os `workerId` que aparecem nas 3 listas DERIVADAS
 * (`team.selected`/`team.inService`/`team.rejected`), nunca o histórico inteiro que o leitor traz —
 * o CTE `alloc` de `ServiceTeamReader` não filtra por status, então `row.assignments` pode conter
 * alocações antigas de prestadores que `deriveServiceTeam` já descartou (`isVigente` = false). Antes,
 * `projectDisplayNames` varria as 3 listas CRUAS do leitor e decifrava todo mundo que aparecesse nelas,
 * mesmo quem não sai na resposta. Um decrypt por prestador DISTINTO, em PARALELO (`Promise.all`) —
 * o quadro B já faz assim (`WJAFunnelController.ts:219-220`); antes, os dois casos de uso decifravam
 * em série (`for (... await ...)`), presos DENTRO da transação no POST.
 */
import type { ServiceTeamRows } from '../infrastructure/ServiceTeamReader';
import {
  deriveServiceTeam,
  deriveAllocationPool,
  ALLOCATION_POOL_RANK,
  type AllocationPoolEntry,
  type AllocationPoolStatus,
  type DeriveServiceTeamResult,
} from '../domain/deriveServiceTeam';
import type { GetServiceTeamResult, ServiceTeamMember } from './GetServiceTeamUseCase';
import { operationDateOf } from './itineraryCoverage';
import type { Decryptor } from '@modules/identity/permissions';
import { projectWorkerDisplayNames, type WorkerNameSource } from './workerDisplayNames';

/**
 * `row → deriveServiceTeam` numa fonte só (DX-11.6, P8) — antes duplicado em
 * `GetServiceTeamUseCase.execute` (`:80-88`) e no `deriveTeam` privado de `ServiceTeamMarkUseCase`
 * (`:223-233`); os dois passam a chamar esta função (P9), mesmo comportamento, mesma contagem de
 * teste. `asOf` é a data LOCAL do PAÍS do paciente (`operationDateOf`), nunca o relógio do processo.
 *
 * DX-13.4 (Fase 13): devolve o time COM `asOf` anexado (`DeriveServiceTeamResult & { asOf }`) — a
 * MESMA `asOf` já calculada aqui, para `buildServiceTeamResult` devolver no `GetServiceTeamResult`
 * sem recalcular. `row.substitutions ?? []` — o leitor da Fase 10 (dublês de teste sem o campo)
 * segue compilando.
 */
export function deriveServiceTeamFromRows(row: ServiceTeamRows, now: Date): DeriveServiceTeamResult & { asOf: string } {
  const asOf = operationDateOf(row.country, now);
  const team = deriveServiceTeam({
    serviceId: row.serviceId,
    liveVacancyId: row.liveVacancyId,
    asOf,
    candidacies: row.candidacies,
    assignments: row.assignments,
    marks: row.marks,
    substitutions: row.substitutions ?? [],
  });
  return { ...team, asOf };
}

/** Pool de alocação (041 R1): a MESMA fonte para as opções do itinerário e para o gate de alocação. */
export function deriveAllocationPoolFromRows(row: ServiceTeamRows, now: Date): AllocationPoolEntry[] {
  return deriveAllocationPool({
    serviceId: row.serviceId,
    liveVacancyId: row.liveVacancyId,
    asOf: operationDateOf(row.country, now),
    candidacies: row.candidacies,
    assignments: row.assignments,
    marks: row.marks,
    substitutions: row.substitutions ?? [],
  });
}

/**
 * UMA projeção por `workerId` distinto das 3 listas DERIVADAS (`team`), nunca do histórico inteiro
 * que `row` carrega — quem não sai em `selected`/`inService`/`rejected` não gasta KMS. `cells ===
 * null` (engine OFF) e a ausência de `worker_contact:read` são decididas DENTRO de
 * `projectWorkerFields`, antes do KMS (D113) — inalterado aqui.
 */
export async function projectServiceTeamDisplayNames(
  row: ServiceTeamRows,
  team: DeriveServiceTeamResult,
  cells: string[] | null,
  kms: Decryptor,
): Promise<Map<string, string | null>> {
  const neededWorkerIds = new Set<string>([
    ...team.selected.map((entry) => entry.workerId),
    ...team.inService.map((entry) => entry.workerId),
    ...team.rejected.map((entry) => entry.workerId),
  ]);

  const sourceByWorkerId = new Map<string, WorkerNameSource>();
  for (const list of [row.candidacies, row.assignments, row.marks, row.substitutions ?? []]) {
    for (const entry of list) {
      if (!neededWorkerIds.has(entry.workerId) || sourceByWorkerId.has(entry.workerId)) continue;
      sourceByWorkerId.set(entry.workerId, {
        firstNameEncrypted: entry.firstNameEncrypted,
        lastNameEncrypted: entry.lastNameEncrypted,
      });
    }
  }

  return projectWorkerDisplayNames(sourceByWorkerId, cells, kms);
}

/**
 * `entry` pode ser um `DeriveServiceTeamSelectedEntry` (sem `allocations`/`substitutionDates`) ou um
 * `DeriveServiceTeamInServiceEntry` (com os 2 opcionais, DX-13.5) — os dois cabem neste tipo largo;
 * as chaves só saem no `ServiceTeamMember` quando o time derivado as trouxe.
 */
function toMember(
  entry: {
    workerId: string;
    vacancyId: string;
    allocations?: { allocationId: string; weekday: number; startTime: string; endTime: string }[];
    substitutionDates?: string[];
  },
  displayNameByWorkerId: Map<string, string | null>,
  occupationByWorkerId: Map<string, string | null>,
): ServiceTeamMember {
  return {
    workerId: entry.workerId,
    displayName: displayNameByWorkerId.get(entry.workerId) ?? null,
    vacancyId: entry.vacancyId,
    ...(entry.allocations ? { allocations: entry.allocations } : {}),
    ...(entry.substitutionDates ? { substitutionDates: entry.substitutionDates } : {}),
    ...(occupationByWorkerId.has(entry.workerId) ? { occupation: occupationByWorkerId.get(entry.workerId) ?? null } : {}),
  };
}

/**
 * `workerId → occupation` só de `row.candidacies` (D445, rodada 2) — é de lá que `selected` sai
 * (`deriveServiceTeam`), e é coluna PLANA (sem KMS, sem célula — `worker:read`, nível base).
 */
function occupationMap(row: Pick<ServiceTeamRows, 'candidacies'>): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const c of row.candidacies) {
    if (!map.has(c.workerId)) map.set(c.workerId, c.occupation ?? null);
  }
  return map;
}

/**
 * Monta o `GetServiceTeamResult` a partir do time derivado — a MESMA forma no GET
 * (`GetServiceTeamUseCase.execute`) e no recálculo pós-escrita (`ServiceTeamMarkUseCase.recompute`).
 * `rejected` usa a vaga VIVA do serviço (`row.liveVacancyId`) — `deriveServiceTeam` não carrega
 * vaga para quem está rejeitado, a marca não é por candidatura. `asOf` (DX-13.4/13.5, Fase 13) vem
 * do `team` — a MESMA data já calculada em `deriveServiceTeamFromRows`, nunca recalculada aqui.
 */
export function buildServiceTeamResult(
  row: Pick<ServiceTeamRows, 'serviceId' | 'liveVacancyId' | 'candidacies'> & Partial<Pick<ServiceTeamRows, 'marks'>>,
  team: DeriveServiceTeamResult & { asOf: string },
  displayNameByWorkerId: Map<string, string | null>,
): GetServiceTeamResult {
  const occupationByWorkerId = occupationMap(row);
  // Rótulo do catálogo do motivo de rejeitar (Fase 2 D2): a tela mostra `reasonLabel ?? reasonCategory`.
  const reasonLabelByWorkerId = new Map<string, string>();
  for (const mark of row.marks ?? []) {
    if (mark.rejectReasonLabel) reasonLabelByWorkerId.set(mark.workerId, mark.rejectReasonLabel);
  }
  return {
    serviceId: row.serviceId,
    vacancyId: row.liveVacancyId,
    asOf: team.asOf,
    selected: team.selected.map((entry) => toMember(entry, displayNameByWorkerId, occupationByWorkerId)),
    inService: team.inService.map((entry) => toMember(entry, displayNameByWorkerId, occupationByWorkerId)),
    rejected: team.rejected.map((entry) => ({
      workerId: entry.workerId,
      displayName: displayNameByWorkerId.get(entry.workerId) ?? null,
      vacancyId: row.liveVacancyId,
      reasonCategory: entry.reasonCategory,
      ...(reasonLabelByWorkerId.has(entry.workerId) ? { reasonLabel: reasonLabelByWorkerId.get(entry.workerId) } : {}),
    })),
  };
}

export interface AllocationOption {
  workerId: string;
  displayName: string | null;
  vacancyId: string;
  status: AllocationPoolStatus;
  occupation: string | null;
}

/** Opções do itinerário: nome/ocupação projetados, ordem IN_SERVICE → QUICK_RESPONSE → SELECTED e alfabética dentro do grupo. */
export function buildAllocationOptions(
  row: Pick<ServiceTeamRows, 'candidacies'>,
  pool: readonly AllocationPoolEntry[],
  displayNameByWorkerId: Map<string, string | null>,
): AllocationOption[] {
  const occupationByWorkerId = occupationMap(row);
  return pool
    .map((entry) => ({
      workerId: entry.workerId,
      displayName: displayNameByWorkerId.get(entry.workerId) ?? null,
      vacancyId: entry.vacancyId,
      status: entry.status,
      occupation: occupationByWorkerId.get(entry.workerId) ?? null,
    }))
    .sort((a, b) => {
      const byRank = ALLOCATION_POOL_RANK[a.status] - ALLOCATION_POOL_RANK[b.status];
      if (byRank !== 0) return byRank;
      if (a.displayName === null || b.displayName === null) {
        if (a.displayName !== b.displayName) return a.displayName === null ? 1 : -1;
      } else {
        const byName = a.displayName.localeCompare(b.displayName, 'es', { sensitivity: 'base' });
        if (byName !== 0) return byName;
      }
      return a.workerId.localeCompare(b.workerId);
    });
}
