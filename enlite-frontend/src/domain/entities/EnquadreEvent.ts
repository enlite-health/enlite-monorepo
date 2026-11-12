/**
 * EnquadreEvent — a forma final do que a API do evento de enquadre devolve (spec 052). A FASE vem derivada do
 * servidor (`phase`): a tela só traduz, nunca recalcula a partir do relógio. O prestador aparece só como opção
 * (`hasValidEmail: boolean`); nenhum endereço de contato trafega por aqui.
 */

export type EnquadreEventPhase = 'scheduled' | 'pending_close' | 'closed' | 'cancelled';

/** Colunas do kanban do evento. Os 3 últimos são os mesmos ids de estágio da vaga (spec §4). */
export type EnquadreColumnId = 'CONVOKED' | 'SELECTED' | 'QUICK_RESPONSE_TEAM' | 'REJECTED';

/** Resultado do convocado num evento encerrado. `returned` = devolvido a Completado (sem marcação). */
export type EnquadreParticipantOutcome = 'selected' | 'quick_response' | 'rejected' | 'returned';

export interface EnquadreOutcomeCounts {
  selected: number;
  quickResponse: number;
  rejected: number;
  returned: number;
}

/**
 * Estados da importação da esteira pós-call (spec §5.5): a MESMA da admissão, logo os mesmos 8 estados de
 * `AdmissionImportStatus` (infraestrutura; o domínio não a importa). `EnquadrePipelineSeals` indexa `IMPORT_SEAL_TONE`
 * (`Record<AdmissionImportStatus, …>`) com este tipo: se um estado desta união não existir lá, o `tsc` reprova.
 */
export type EnquadreImportStatus =
  | 'pending' | 'waiting' | 'done' | 'rejected' | 'ambiguous' | 'expired' | 'blocked' | 'no_show';

/**
 * Esteira pós-call (spec §5.5). O servidor DERIVA tudo do `import_status`, do documento do resumo e da presença medida.
 * `summary` é AUSENTE (a chave nem vem) quando o usuário não tem a célula `enquadre_summary:read`: sem ela nem o selo do resumo
 * nem o botão de baixar existem na tela.
 */
export interface EnquadrePipelineState {
  importStatus: EnquadreImportStatus | null;
  summary?: 'waiting' | 'ready' | 'unavailable';
  /** Código fechado do motivo (`no_link`, `wrong_account`, `meet_scope_missing`...) quando `importStatus === 'blocked'`; a tela o traduz. */
  blockedReason: string | null;
  /** Convocados que o app não conseguiu ligar a ninguém da call (presença `unidentified`). 0 = nenhum ou presença ainda não medida. */
  unidentifiedCount: number;
}

export interface EnquadreEventListItem {
  id: string;
  /** ISO. */
  startsAt: string;
  endsAt: string;
  hostName: string;
  /** País do evento (o da vaga): data e hora da tela saem no fuso dele. */
  country: 'AR' | 'BR';
  phase: EnquadreEventPhase;
  convokedCount: number;
  /** Convocados já com marcação (selecionado/resposta rápida/rejeitado). Derivado no servidor; alimenta "N marcados de M" em `pending_close`. */
  markedCount: number;
  outcome: EnquadreOutcomeCounts;
  /** Servidor devolve `null` para evento encerrado/cancelado. */
  meetLink: string | null;
  pipeline: EnquadrePipelineState | null;
}

export interface EnquadreParticipant {
  id: string;
  workerId: string;
  workerName: string;
  occupation: string | null;
  column: EnquadreColumnId;
  outcome: EnquadreParticipantOutcome | null;
  rejectionReasonCategory: string | null;
}

export interface EnquadreEventDetail extends EnquadreEventListItem {
  participants: EnquadreParticipant[];
  /** Convocados SEM marcação que voltam a Completado ao encerrar. Derivado no servidor; o corpo do diálogo de encerrar usa este número. */
  unmarkedCount: number;
}

export interface EnquadreWorkerOption {
  id: string;
  name: string;
  hasValidEmail: boolean;
}

export type EnquadreHostLinkState = 'linked' | 'unlinked';

export interface EnquadreHostOption {
  id: string;
  name: string;
  linkState: EnquadreHostLinkState;
}

/** Completados fora de evento aberto; `count` alimenta o cabeçalho ("N completados sin evento"). */
export interface EnquadreAvailableWorkers {
  workers: EnquadreWorkerOption[];
  count: number;
}

export interface CreateEnquadreEventInput {
  hostId: string;
  /** Hora de PAREDE `YYYY-MM-DDTHH:mm`, sem offset (molde da Admissão): quem a interpreta no fuso é o servidor. */
  startsAt: string;
  durationMinutes: number;
  workerIds: string[];
}

/** Status do EVENTO (não a fase): o filtro da lista global (spec 076) e `status` da linha. */
export type EnquadreEventStatus = 'open' | 'closed' | 'cancelled';

/**
 * Uma linha da lista GLOBAL de enquadres (spec 076, `GET /api/admin/enquadre-events`). Sem nome de paciente, de convocado,
 * e-mail ou telefone (FR-21): só código, caso, entrevistador (nome de exibição de staff) e contagens. `startsAt` já vem no
 * fuso do país do evento; a tela formata com o mesmo helper da aba da vaga.
 */
export interface EnquadreGlobalListItem {
  id: string;
  jobPostingId: string;
  caseNumber: number | null;
  caseOrdinal: number | null;
  eventCode: string;
  startsAt: string;
  endsAt: string;
  country: 'AR' | 'BR';
  hostName: string;
  status: EnquadreEventStatus;
  phase: EnquadreEventPhase;
  convokedCount: number;
  /** Motivo (código fechado) quando a importação da esteira está `blocked`; `null` nos demais estados. */
  importBlocked: { reason: string } | null;
}

/**
 * A página + os totais do conjunto filtrado INTEIRO (`total`/`convokedTotal` vêm do servidor: a tela nunca soma a página).
 * `range.from/to` chegam como texto `YYYY-MM-DD`; `defaulted` = o servidor aplicou a semana atual.
 */
export interface EnquadreGlobalList {
  items: EnquadreGlobalListItem[];
  total: number;
  convokedTotal: number;
  hosts: string[];
  range: { from: string; to: string; defaulted: boolean };
  scope: { countries: string[]; requested: string };
}

export interface EnquadreGlobalListParams {
  /** `YYYY-MM-DD`. Só vão à URL as DUAS juntas; uma sozinha é descartada (o servidor responde 400). */
  from?: string;
  to?: string;
  status?: readonly EnquadreEventStatus[];
  host?: string;
  country?: string;
  q?: string;
  limit?: number;
  offset?: number;
}
