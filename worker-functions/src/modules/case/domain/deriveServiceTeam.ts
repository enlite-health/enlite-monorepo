/**
 * deriveServiceTeam — quadro C (Servicio Contratado), Fase 10, DX-10.4. Função pura: nada de
 * banco/`Date`/`Intl` aqui, a vigência da alocação é REUSADA de `isVigente`
 * (`ServiceCoverageCalculator.ts:63`, ressalva (c') — reimplementar duplicaria a regra).
 *
 * Três conjuntos, DISJUNTOS POR CONSTRUÇÃO (critério 1), com precedência alocado > rejeitado
 * (invariante 10 impede o par pela API, mas esta função não confia nisso: dado legado com as
 * duas coisas mostra a pessoa onde ela está trabalhando, e a marca reaparece quando a alocação
 * acabar):
 *   - `inService` = alocações vigentes do serviço (`isVigente`) MAIS os substitutos com data
 *                   vigente (`date >= asOf`, DX-13.3 — Fase 13);
 *   - `rejected`  = marcas ativas do serviço, MENOS quem está alocado;
 *   - `selected`  = candidatos da vaga viva (`liveVacancyId`) na etapa `QUICK_RESPONSE_TEAM`,
 *                   MENOS alocado e MENOS rejeitado.
 * Cada lista sem repetição de `workerId`, na ordem de entrada.
 *
 * DX-13.3 (Fase 13): `substitutions` é OPCIONAL e comparado por string `YYYY-MM-DD`, nunca `Date`.
 * O titular NÃO sai de `inService` por causa da ausência — só a substituição entra na derivação;
 * quem é titular E substituto no mesmo serviço recebe uma ÚNICA entrada com `allocations` e
 * `substitutionDates`. Passada a última data, a substituição some da vigência e o substituto volta
 * a `selected` por derivação (nenhuma escrita, DX-13.4).
 */
import { isVigente, type ItineraryAssignmentStatus } from './ServiceCoverageCalculator';

/** A etapa do quadro B que faz um prestador entrar como candidato do quadro C (DX-10.4). */
export const SERVICE_TEAM_ENTRY_STAGE = 'QUICK_RESPONSE_TEAM' as const;

export interface DeriveServiceTeamCandidacy {
  workerId: string;
  vacancyId: string;
  stage: string;
}

export interface DeriveServiceTeamAssignment {
  workerId: string;
  serviceId: string;
  vacancyId: string;
  validFrom: string;
  validTo: string | null;
  status: ItineraryAssignmentStatus;
  /** Os 4 só existem quando o leitor manda o horário da alocação (DX-13.5) — nenhum, no leitor da Fase 10. */
  allocationId?: string;
  weekday?: number;
  startTime?: string;
  endTime?: string;
}

/** As marcas já chegam ATIVAS — `reverted_at IS NULL` é filtro do leitor, não desta função. */
export interface DeriveServiceTeamMark {
  workerId: string;
  serviceId: string;
  rejectReasonCategory: string;
}

/** Uma por ausência não cancelada COM substituto (DX-13.3) — o leitor não agrega, esta função agrupa. */
export interface DeriveServiceTeamSubstitution {
  workerId: string;
  serviceId: string;
  vacancyId: string;
  date: string;
}

export interface DeriveServiceTeamInput {
  serviceId: string;
  liveVacancyId: string | null;
  asOf: string;
  candidacies: readonly DeriveServiceTeamCandidacy[];
  assignments: readonly DeriveServiceTeamAssignment[];
  marks: readonly DeriveServiceTeamMark[];
  /** Opcional: os chamadores/testes da Fase 10 seguem compilando sem mudança (DX-13.3). */
  substitutions?: readonly DeriveServiceTeamSubstitution[];
}

export interface DeriveServiceTeamSelectedEntry {
  workerId: string;
  vacancyId: string;
}

export interface DeriveServiceTeamInServiceEntry {
  workerId: string;
  vacancyId: string;
  /** As alocações vigentes do titular com horário (DX-13.5) — só quando o leitor mandou `allocationId`. */
  allocations?: { allocationId: string; weekday: number; startTime: string; endTime: string }[];
  /** Datas vigentes em que este worker substitui, ordem crescente, sem repetição (DX-13.3). */
  substitutionDates?: string[];
}

export interface DeriveServiceTeamRejectedEntry {
  workerId: string;
  reasonCategory: string;
}

export interface DeriveServiceTeamResult {
  selected: DeriveServiceTeamSelectedEntry[];
  inService: DeriveServiceTeamInServiceEntry[];
  rejected: DeriveServiceTeamRejectedEntry[];
}

/** Mantém a primeira ocorrência de cada `workerId`, na ordem de entrada — sem repetição (critério 1). */
function dedupeByWorkerId<T extends { workerId: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    if (seen.has(item.workerId)) continue;
    seen.add(item.workerId);
    result.push(item);
  }
  return result;
}

/** Sem repetição, ordem crescente — string `YYYY-MM-DD` (nunca `Date`). */
function sortUniqueDates(dates: readonly string[]): string[] {
  return [...new Set(dates)].sort();
}

export function deriveServiceTeam(input: DeriveServiceTeamInput): DeriveServiceTeamResult {
  const { serviceId, liveVacancyId, asOf, candidacies, assignments, marks, substitutions = [] } = input;

  const vigentAssignments = assignments.filter((a) => a.serviceId === serviceId && isVigente(a, asOf));
  const vigentSubstitutions = substitutions.filter((s) => s.serviceId === serviceId && s.date >= asOf);

  // Datas + vaga por substituto vigente (DX-13.3) — a 1ª vaga vista é a que sai no `inService`.
  const substitutionDatesByWorkerId = new Map<string, string[]>();
  const substitutionVacancyByWorkerId = new Map<string, string>();
  for (const s of vigentSubstitutions) {
    substitutionDatesByWorkerId.set(s.workerId, [...(substitutionDatesByWorkerId.get(s.workerId) ?? []), s.date]);
    if (!substitutionVacancyByWorkerId.has(s.workerId)) substitutionVacancyByWorkerId.set(s.workerId, s.vacancyId);
  }
  for (const [workerId, dates] of substitutionDatesByWorkerId) {
    substitutionDatesByWorkerId.set(workerId, sortUniqueDates(dates));
  }

  const allocatedWorkerIds = new Set([...vigentAssignments.map((a) => a.workerId), ...substitutionDatesByWorkerId.keys()]);

  // Alocações vigentes com horário, agrupadas por titular (DX-13.5) — só quem tem `allocationId`.
  const allocationsByWorkerId = new Map<
    string,
    { allocationId: string; weekday: number; startTime: string; endTime: string }[]
  >();
  for (const a of vigentAssignments) {
    if (a.allocationId === undefined) continue;
    const list = allocationsByWorkerId.get(a.workerId) ?? [];
    list.push({ allocationId: a.allocationId, weekday: a.weekday as number, startTime: a.startTime as string, endTime: a.endTime as string });
    allocationsByWorkerId.set(a.workerId, list);
  }

  const titulares: DeriveServiceTeamInServiceEntry[] = dedupeByWorkerId(
    vigentAssignments.map((a) => ({ workerId: a.workerId, vacancyId: a.vacancyId })),
  ).map((entry) => {
    const allocations = allocationsByWorkerId.get(entry.workerId);
    const substitutionDates = substitutionDatesByWorkerId.get(entry.workerId);
    return {
      ...entry,
      ...(allocations && allocations.length > 0 ? { allocations } : {}),
      ...(substitutionDates && substitutionDates.length > 0 ? { substitutionDates } : {}),
    };
  });

  // Substitutos que não são titulares deste serviço, ordenados pela 1ª data de substituição.
  const titularWorkerIds = new Set(titulares.map((t) => t.workerId));
  const substitutosSemAlocacao: DeriveServiceTeamInServiceEntry[] = [...substitutionDatesByWorkerId.entries()]
    .filter(([workerId]) => !titularWorkerIds.has(workerId))
    .sort(([, datesA], [, datesB]) => datesA[0].localeCompare(datesB[0]))
    .map(([workerId, substitutionDates]) => ({
      workerId,
      vacancyId: substitutionVacancyByWorkerId.get(workerId) as string,
      substitutionDates,
    }));

  const inService = [...titulares, ...substitutosSemAlocacao];

  const marksForService = marks.filter((m) => m.serviceId === serviceId);
  const rejected = dedupeByWorkerId(
    marksForService
      .filter((m) => !allocatedWorkerIds.has(m.workerId))
      .map((m) => ({ workerId: m.workerId, reasonCategory: m.rejectReasonCategory })),
  );
  const rejectedWorkerIds = new Set(rejected.map((r) => r.workerId));

  const candidatesForLiveVacancy =
    liveVacancyId === null
      ? []
      : candidacies.filter((c) => c.vacancyId === liveVacancyId && c.stage === SERVICE_TEAM_ENTRY_STAGE);
  const selected = dedupeByWorkerId(
    candidatesForLiveVacancy
      .filter((c) => !allocatedWorkerIds.has(c.workerId) && !rejectedWorkerIds.has(c.workerId))
      .map((c) => ({ workerId: c.workerId, vacancyId: c.vacancyId })),
  );

  return { selected, inService, rejected };
}

// ── Pool de alocação (041 R1, DEC-04/DEC-05) ───────────────────────────────────────────────────
// As opções do itinerário e o gate de alocação vêm do STEP FINAL DA VACANTE: quem está nas colunas
// "Selecionados" (`SELECTED`) e "Equipe de Resposta Rápida" (`QUICK_RESPONSE_TEAM`) da vaga viva,
// MENOS quem tem marca de rejeição no serviço (a marca segue existindo como dado — Q3). Quem já
// está alocado (e continua numa das duas colunas) PERMANECE na lista, marcado `IN_SERVICE`.
// `deriveServiceTeam` (quadro C) NÃO muda: `selected` segue sendo só `QUICK_RESPONSE_TEAM` não alocado.

/** As colunas do funil da vacante que alimentam o pool (`WorkerJobApplication.ts:47-48`). */
export const ALLOCATION_POOL_STAGES = ['SELECTED', 'QUICK_RESPONSE_TEAM'] as const;

export type AllocationPoolStatus = 'IN_SERVICE' | 'QUICK_RESPONSE' | 'SELECTED';

export interface AllocationPoolEntry {
  workerId: string;
  vacancyId: string;
  status: AllocationPoolStatus;
}

/** IN_SERVICE → QUICK_RESPONSE → SELECTED (a ordem da lista; Q2). */
export const ALLOCATION_POOL_RANK: Record<AllocationPoolStatus, number> = {
  IN_SERVICE: 0,
  QUICK_RESPONSE: 1,
  SELECTED: 2,
};

export function deriveAllocationPool(input: DeriveServiceTeamInput): AllocationPoolEntry[] {
  const team = deriveServiceTeam(input);
  const inServiceIds = new Set(team.inService.map((e) => e.workerId));
  const rejectedIds = new Set(team.rejected.map((e) => e.workerId));
  const { liveVacancyId, candidacies } = input;
  if (liveVacancyId === null) return [];

  const poolStages: readonly string[] = ALLOCATION_POOL_STAGES;
  const inPool = candidacies.filter(
    (c) => c.vacancyId === liveVacancyId && poolStages.includes(c.stage) && !rejectedIds.has(c.workerId),
  );
  // Quem está nas duas colunas (dado legado) fica na mais avançada: QUICK_RESPONSE_TEAM.
  const ordered = [...inPool].sort((a, b) => Number(b.stage === SERVICE_TEAM_ENTRY_STAGE) - Number(a.stage === SERVICE_TEAM_ENTRY_STAGE));

  const entries: AllocationPoolEntry[] = dedupeByWorkerId(ordered).map((c) => ({
    workerId: c.workerId,
    vacancyId: c.vacancyId,
    status: inServiceIds.has(c.workerId) ? 'IN_SERVICE' : c.stage === SERVICE_TEAM_ENTRY_STAGE ? 'QUICK_RESPONSE' : 'SELECTED',
  }));
  return entries.sort((a, b) => ALLOCATION_POOL_RANK[a.status] - ALLOCATION_POOL_RANK[b.status]);
}
