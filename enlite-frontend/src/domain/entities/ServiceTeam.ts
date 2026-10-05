/**
 * Quadro C ("Encuadre" do serviço contratado — D432, o nome só existe como TEXTO de tela; o
 * identificador é `serviceTeam`, critério 14). O time é CALCULADO por serviço/vaga (nunca uma
 * tabela própria de membros): o GET junta a seleção do quadro B, a alocação viva do itinerário
 * (480) e a marca de rejeição (`contracted_service_rejections`, migration 481). Este arquivo é
 * só o espelho do formato — o cálculo mora na API (DX-10.6/10.7).
 */

/**
 * Uma faixa (slot) semanal alocada ao titular — de onde a Fase 13 oferece "Sustituir un día"
 * (a API calcula; o front só lista o que veio em `member.allocations`).
 */
export interface ServiceTeamAllocation {
  allocationId: string;
  weekday: number;
  startTime: string;
  endTime: string;
}

/**
 * Uma linha do time. `displayName` vem `null` quando o ator não tem a célula de nome do
 * prestador (projeção KMS, DX-10.6) — a tela mostra "sin nombre" nesse caso, nunca o `workerId`.
 * `vacancyId` é a vaga (job_posting) da candidatura/alocação DESTE prestador, não a do serviço.
 * `reasonCategory` só vem preenchido em `rejected` (a categoria gravada na marca ativa).
 * `allocations`/`substitutionDates` (Fase 13) só vêm em `inService` — as faixas semanais do
 * titular e as datas em que ELE é o substituído (a API calcula; nenhuma conta no front).
 */
export interface ServiceTeamMember {
  workerId: string;
  displayName: string | null;
  vacancyId: string | null;
  reasonCategory?: string;
  /** Só em `rejected`: rótulo do motivo no catálogo de motivos de saída (Fase 2); a tela mostra `reasonLabel ?? reasonCategory`. */
  reasonLabel?: string;
  allocations?: ServiceTeamAllocation[];
  substitutionDates?: string[];
  /**
   * D445 (rodada 2) — `workers.occupation`, coluna PLANA (sem KMS, sem célula de contato/PII: já
   * sai no nível base `worker:read` de `projectWorkerFields.ts`). Só em `selected` (é o que
   * "Preseleccionados" do modal de itinerário usa); mesmo vocabulário de `SERVICE_CODES` — o
   * rótulo é `serviceTypes.<code>`, a MESMA chave i18n do quadro de serviços contratados.
   */
  occupation?: string | null;
  /** 041 R2 — só em `allocation-options`: de onde o nome vem (em atendimento, resposta rápida ou só selecionado). */
  status?: AllocationOptionStatus;
}

/** Estado de uma opção do itinerário; a API já devolve a lista ordenada IN_SERVICE → QUICK_RESPONSE → SELECTED. */
export type AllocationOptionStatus = 'IN_SERVICE' | 'QUICK_RESPONSE' | 'SELECTED';

/**
 * GET /api/admin/patients/:id/contracted-services/:sid/team (DX-10.7). `vacancyId` aqui é a vaga
 * VIVA do serviço (fonte única, `liveVacancySql`) — `null` sem recrutamento ativo (critério "sem
 * vaga"). POST .../team/reject e .../team/revert devolvem o mesmo formato, já recalculado.
 * `asOf` (Fase 13) é a data de operação usada para derivar o time — vem SEMPRE da API
 * (`operationDateOf`), nunca do relógio do navegador.
 */
export interface ServiceTeam {
  serviceId: string;
  vacancyId: string | null;
  asOf: string;
  selected: ServiceTeamMember[];
  inService: ServiceTeamMember[];
  rejected: ServiceTeamMember[];
}

/**
 * Resultado de POST .../absences, PATCH .../absences/:id/substitute e POST .../absences/:id/cancel
 * (DX-13.7) — nunca traz nome/dado do prestador; o time atualizado vem por um GET separado
 * (`useServiceTeam.substitute`, DX-13.11).
 */
export interface ItineraryAbsenceResult {
  absenceId: string;
  allocationId: string;
  date: string;
  substituteWorkerId: string | null;
  status: 'OPEN' | 'CANCELLED';
}

/** Destino de quem sai do itinerário (change itinerario-trocas-motivos-e-figma, Fase 4): segue como reserva ou sai do encuadre do serviço. */
export type ExitDestination = 'RESERVE' | 'LEAVE_SERVICE';

/** Resposta de `POST .../itinerary/allocations/:allocationId/end` (tirar do itinerário com motivo e destino). */
export interface ItineraryRemoveResult {
  allocationId: string;
  status: 'ENDED';
  validTo: string;
  destination: ExitDestination;
}

/** As 3 colunas do quadro C, na ordem em que a tela renderiza. */
export const SERVICE_TEAM_COLUMN_IDS = ['SELECTED_FOR_SERVICE', 'IN_SERVICE', 'REJECTED_FOR_SERVICE'] as const;

export type ServiceTeamColumnId = (typeof SERVICE_TEAM_COLUMN_IDS)[number];

/**
 * Espelho de `SERVICE_TEAM_REVERT_REASONS`
 * (`CASE/domain/serviceTeamReason.ts`, DX-10.2) — catálogo de RÓTULO para o modal de motivo de REVERTER (o de
 * REJEITAR é o catálogo de motivos de saída, vindo de `useServiceExitReasonOptions`, Fase 2)
 * (molde `MoveReason.ts:26-45`). O front nunca decide QUANDO motivo é obrigatório; só reage ao
 * 422 `SERVICE_TEAM_REASON_REQUIRED`/`SERVICE_TEAM_REASON_INVALID` que a API devolve (invariantes
 * 10/11). A lista de reverter coincide hoje com `LEAVE_REJECTED_REASONS` — decisão (invariante 6):
 * não são a mesma constante.
 */
export const SERVICE_TEAM_REVERT_REASONS = ['REAVALIACAO', 'REJEITADO_POR_ENGANO', 'OTHER'] as const;

export type ServiceTeamReasonKind = 'REJECT' | 'REVERT';

/**
 * Modal do prestador (Figma, rodada 2, decisão D) — o "Historial" (FECHA/NOTA/RESPUESTA): uma
 * linha por "Guardar", append-only (migration 490, nunca editada). `contacted` é a RESPUESTA.
 */
export interface ServiceTeamContactHistoryEntry {
  id: string;
  contacted: boolean;
  eventDate: string;
  note: string | null;
  createdAt: string;
}

/**
 * GET/POST .../team/:workerId/contact. `displayName` já vem PROJETADO pela célula
 * `worker_contact:read` (o mesmo portão que já protege o nome no quadro C) — rótulo redigido sem a
 * célula, nunca erro; o front NUNCA decide quem vê o quê, só renderiza o que a API mandou. O
 * telefone do prestador não faz parte do contrato (D447.3: o painel é focado no paciente).
 */
export interface ServiceTeamContact {
  workerId: string;
  displayName: string | null;
  history: ServiceTeamContactHistoryEntry[];
}

/** Body de POST .../team/:workerId/contact — `note` é texto livre (Notas), opcional. */
export interface RegisterServiceTeamContactBody {
  contacted: boolean;
  eventDate: string;
  note: string | null;
}
