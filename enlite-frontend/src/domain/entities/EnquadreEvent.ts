/**
 * EnquadreEvent — a forma final do que a API do evento de enquadre devolve (spec 052). A FASE vem derivada do
 * servidor (`phase`): a tela só traduz, nunca recalcula a partir do relógio. O prestador aparece só como opção
 * (`hasValidEmail: boolean`); nenhum endereço de contato trafega por aqui.
 */
import type { AdmissionImportStatus } from '@infrastructure/http/AdminAdmissionApiService';

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

/** Esteira pós-call (spec §5.5): a mesma da admissão, logo os mesmos estados de importação. */
export interface EnquadrePipelineState {
  importStatus: AdmissionImportStatus | null;
  summary: 'waiting' | 'ready' | 'unavailable';
  /** Motivo escrito quando `importStatus === 'blocked'`. */
  blockedReason: string | null;
}

export interface EnquadreEventListItem {
  id: string;
  /** ISO. */
  startsAt: string;
  endsAt: string;
  hostName: string;
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
