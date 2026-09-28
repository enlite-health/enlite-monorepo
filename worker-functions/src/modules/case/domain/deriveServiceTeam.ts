/**
 * deriveServiceTeam — quadro C (Servicio Contratado), Fase 10, DX-10.4. Função pura: nada de
 * banco/`Date`/`Intl` aqui, a vigência da alocação é REUSADA de `isVigente`
 * (`ServiceCoverageCalculator.ts:63`, ressalva (c') — reimplementar duplicaria a regra).
 *
 * Três conjuntos, DISJUNTOS POR CONSTRUÇÃO (critério 1), com precedência alocado > rejeitado
 * (invariante 10 impede o par pela API, mas esta função não confia nisso: dado legado com as
 * duas coisas mostra a pessoa onde ela está trabalhando, e a marca reaparece quando a alocação
 * acabar):
 *   - `inService` = alocações vigentes do serviço (`isVigente`);
 *   - `rejected`  = marcas ativas do serviço, MENOS quem está alocado;
 *   - `selected`  = candidatos da vaga viva (`liveVacancyId`) na etapa `QUICK_RESPONSE_TEAM`,
 *                   MENOS alocado e MENOS rejeitado.
 * Cada lista sem repetição de `workerId`, na ordem de entrada.
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
}

/** As marcas já chegam ATIVAS — `reverted_at IS NULL` é filtro do leitor, não desta função. */
export interface DeriveServiceTeamMark {
  workerId: string;
  serviceId: string;
  rejectReasonCategory: string;
}

export interface DeriveServiceTeamInput {
  serviceId: string;
  liveVacancyId: string | null;
  asOf: string;
  candidacies: readonly DeriveServiceTeamCandidacy[];
  assignments: readonly DeriveServiceTeamAssignment[];
  marks: readonly DeriveServiceTeamMark[];
}

export interface DeriveServiceTeamSelectedEntry {
  workerId: string;
  vacancyId: string;
}

export interface DeriveServiceTeamInServiceEntry {
  workerId: string;
  vacancyId: string;
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

export function deriveServiceTeam(input: DeriveServiceTeamInput): DeriveServiceTeamResult {
  const { serviceId, liveVacancyId, asOf, candidacies, assignments, marks } = input;

  const vigentAssignments = assignments.filter((a) => a.serviceId === serviceId && isVigente(a, asOf));
  const allocatedWorkerIds = new Set(vigentAssignments.map((a) => a.workerId));
  const inService = dedupeByWorkerId(
    vigentAssignments.map((a) => ({ workerId: a.workerId, vacancyId: a.vacancyId })),
  );

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
