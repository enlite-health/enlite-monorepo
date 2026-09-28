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
import { deriveServiceTeam, type DeriveServiceTeamResult } from '../domain/deriveServiceTeam';
import type { GetServiceTeamResult, ServiceTeamMember } from './GetServiceTeamUseCase';
import { operationDateOf } from './itineraryCoverage';
import { projectWorkerFields, NOME_REDIGIDO, type Decryptor } from '@modules/identity/permissions';

/**
 * `row → deriveServiceTeam` numa fonte só (DX-11.6, P8) — antes duplicado em
 * `GetServiceTeamUseCase.execute` (`:80-88`) e no `deriveTeam` privado de `ServiceTeamMarkUseCase`
 * (`:223-233`); os dois passam a chamar esta função (P9), mesmo comportamento, mesma contagem de
 * teste. `asOf` é a data LOCAL do PAÍS do paciente (`operationDateOf`), nunca o relógio do processo.
 */
export function deriveServiceTeamFromRows(row: ServiceTeamRows, now: Date): DeriveServiceTeamResult {
  const asOf = operationDateOf(row.country, now);
  return deriveServiceTeam({
    serviceId: row.serviceId,
    liveVacancyId: row.liveVacancyId,
    asOf,
    candidacies: row.candidacies,
    assignments: row.assignments,
    marks: row.marks,
  });
}

interface WorkerNameSource {
  firstNameEncrypted: string | null;
  lastNameEncrypted: string | null;
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
  for (const list of [row.candidacies, row.assignments, row.marks]) {
    for (const entry of list) {
      if (!neededWorkerIds.has(entry.workerId) || sourceByWorkerId.has(entry.workerId)) continue;
      sourceByWorkerId.set(entry.workerId, {
        firstNameEncrypted: entry.firstNameEncrypted,
        lastNameEncrypted: entry.lastNameEncrypted,
      });
    }
  }

  const projected = await Promise.all(
    [...sourceByWorkerId.entries()].map(async ([workerId, source]) => {
      const result = await projectWorkerFields(
        cells,
        { firstNameEncrypted: source.firstNameEncrypted, lastNameEncrypted: source.lastNameEncrypted, phone: null },
        kms,
      );
      const displayName = result.name && result.name !== NOME_REDIGIDO ? result.name : null;
      return [workerId, displayName] as const;
    }),
  );

  return new Map(projected);
}

function toMember(
  entry: { workerId: string; vacancyId: string },
  displayNameByWorkerId: Map<string, string | null>,
): ServiceTeamMember {
  return {
    workerId: entry.workerId,
    displayName: displayNameByWorkerId.get(entry.workerId) ?? null,
    vacancyId: entry.vacancyId,
  };
}

/**
 * Monta o `GetServiceTeamResult` a partir do time derivado — a MESMA forma no GET
 * (`GetServiceTeamUseCase.execute`) e no recálculo pós-escrita (`ServiceTeamMarkUseCase.recompute`).
 * `rejected` usa a vaga VIVA do serviço (`row.liveVacancyId`) — `deriveServiceTeam` não carrega
 * vaga para quem está rejeitado, a marca não é por candidatura.
 */
export function buildServiceTeamResult(
  row: Pick<ServiceTeamRows, 'serviceId' | 'liveVacancyId'>,
  team: DeriveServiceTeamResult,
  displayNameByWorkerId: Map<string, string | null>,
): GetServiceTeamResult {
  return {
    serviceId: row.serviceId,
    vacancyId: row.liveVacancyId,
    selected: team.selected.map((entry) => toMember(entry, displayNameByWorkerId)),
    inService: team.inService.map((entry) => toMember(entry, displayNameByWorkerId)),
    rejected: team.rejected.map((entry) => ({
      workerId: entry.workerId,
      displayName: displayNameByWorkerId.get(entry.workerId) ?? null,
      vacancyId: row.liveVacancyId,
      reasonCategory: entry.reasonCategory,
    })),
  };
}
