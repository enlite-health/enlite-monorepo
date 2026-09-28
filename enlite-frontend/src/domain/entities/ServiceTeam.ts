/**
 * Quadro C ("Encuadre" do serviço contratado — D432, o nome só existe como TEXTO de tela; o
 * identificador é `serviceTeam`, critério 14). O time é CALCULADO por serviço/vaga (nunca uma
 * tabela própria de membros): o GET junta a seleção do quadro B, a alocação viva do itinerário
 * (480) e a marca de rejeição (`contracted_service_rejections`, migration 481). Este arquivo é
 * só o espelho do formato — o cálculo mora na API (DX-10.6/10.7).
 */

/**
 * Uma linha do time. `displayName` vem `null` quando o ator não tem a célula de nome do
 * prestador (projeção KMS, DX-10.6) — a tela mostra "sin nombre" nesse caso, nunca o `workerId`.
 * `vacancyId` é a vaga (job_posting) da candidatura/alocação DESTE prestador, não a do serviço.
 * `reasonCategory` só vem preenchido em `rejected` (a categoria gravada na marca ativa).
 */
export interface ServiceTeamMember {
  workerId: string;
  displayName: string | null;
  vacancyId: string | null;
  reasonCategory?: string;
}

/**
 * GET /api/admin/patients/:id/contracted-services/:sid/team (DX-10.7). `vacancyId` aqui é a vaga
 * VIVA do serviço (fonte única, `liveVacancySql`) — `null` sem recrutamento ativo (critério "sem
 * vaga"). POST .../team/reject e .../team/revert devolvem o mesmo formato, já recalculado.
 */
export interface ServiceTeam {
  serviceId: string;
  vacancyId: string | null;
  selected: ServiceTeamMember[];
  inService: ServiceTeamMember[];
  rejected: ServiceTeamMember[];
}

/** As 3 colunas do quadro C, na ordem em que a tela renderiza. */
export const SERVICE_TEAM_COLUMN_IDS = ['SELECTED_FOR_SERVICE', 'IN_SERVICE', 'REJECTED_FOR_SERVICE'] as const;

export type ServiceTeamColumnId = (typeof SERVICE_TEAM_COLUMN_IDS)[number];

/**
 * Espelho de `SERVICE_TEAM_REJECT_REASONS`/`SERVICE_TEAM_REVERT_REASONS`
 * (`CASE/domain/serviceTeamReason.ts`, DX-10.2) — catálogo de RÓTULO para o modal de motivo
 * (molde `MoveReason.ts:26-45`). O front nunca decide QUANDO motivo é obrigatório; só reage ao
 * 422 `SERVICE_TEAM_REASON_REQUIRED`/`SERVICE_TEAM_REASON_INVALID` que a API devolve (invariantes
 * 10/11). A lista de reverter coincide hoje com `LEAVE_REJECTED_REASONS` — decisão (invariante 6):
 * não são a mesma constante.
 */
export const SERVICE_TEAM_REJECT_REASONS = [
  'PERFIL_INADEQUADO_AO_SERVICO',
  'INDISPONIBILIDADE_DE_HORARIO',
  'DESISTENCIA_DO_PRESTADOR',
  'OTHER',
] as const;

export const SERVICE_TEAM_REVERT_REASONS = ['REAVALIACAO', 'REJEITADO_POR_ENGANO', 'OTHER'] as const;

export type ServiceTeamReasonKind = 'REJECT' | 'REVERT';
