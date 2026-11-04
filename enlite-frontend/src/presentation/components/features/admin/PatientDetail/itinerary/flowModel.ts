import type {
  ConflictState,
  CreateSubstitutionBody,
  PreviewConflict,
  PreviewShift,
  SubstitutionPreviewBody,
  SubstitutionRequestType,
} from '@domain/entities/SubstitutionRequest';
import type { ExitDestination } from '@domain/entities/ServiceTeam';

/**
 * O modelo do fluxo "Nueva sustitución" (spec 069, US3-US5): só estado e regras de FORMA da tela. O que o sistema sabe — os turnos da
 * pessoa, o conflito, o estado novo — vem da pré-visão do servidor; aqui nada é calculado além de "quem cobre cada turno" (a escolha
 * do operador) e de "pode avançar" (todo turno resolvido e sem conflito).
 */

export type CoverMode = 'one' | 'perDay' | 'nobody';

export interface FlowDraft {
  outgoingWorkerId: string | null;
  type: SubstitutionRequestType | null;
  /** `YYYY-MM-DD`; vazio = ainda não digitada. */
  from: string;
  to: string;
  /** P16: abre SEM escolha — `null` até o operador marcar. */
  coverMode: CoverMode | null;
  /** "Una persona para todos los días". */
  person: string | null;
  /** Por turno (`shiftKey`): quem cobre (`string`), "Nadie todavía" (`null`) ou ainda sem escolha (ausente). */
  dayChoices: Record<string, string | null>;
  reason: string;
  destination: ExitDestination | '';
}

export const EMPTY_DRAFT: FlowDraft = {
  outgoingWorkerId: null,
  type: null,
  from: '',
  to: '',
  coverMode: null,
  person: null,
  dayChoices: {},
  reason: '',
  destination: '',
};

export const shiftKey = (shift: Pick<PreviewShift, 'date' | 'slotId'>): string => `${shift.date}|${shift.slotId}`;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Por que o período ainda não vale (a tela mostra a mensagem; `null` = pode perguntar à pré-visão). */
export type PeriodProblem = 'incomplete' | 'past' | 'toBeforeFrom';

export function periodProblem(draft: FlowDraft, asOf: string): PeriodProblem | null {
  if (draft.type === null || !ISO_DATE.test(draft.from)) return 'incomplete';
  if (draft.from < asOf) return 'past';
  if (draft.type === 'DAYS') {
    if (!ISO_DATE.test(draft.to)) return 'incomplete';
    if (draft.to < draft.from) return 'toBeforeFrom';
  }
  return null;
}

/** O corpo da pré-visão do período (sem candidatos): a ÚNICA fonte dos turnos que a tela mostra. `null` = período inválido/incompleto. */
export function periodPreviewBody(draft: FlowDraft, asOf: string, candidateWorkerIds: string[] = []): SubstitutionPreviewBody | null {
  if (draft.outgoingWorkerId === null || periodProblem(draft, asOf) !== null) return null;
  if (draft.type === 'PERMANENT') return { type: 'PERMANENT', outgoingWorkerId: draft.outgoingWorkerId, from: draft.from, candidateWorkerIds };
  if (draft.type === 'ONE_DAY') return { type: 'ONE_DAY', outgoingWorkerId: draft.outgoingWorkerId, from: draft.from, candidateWorkerIds };
  return { type: 'DAYS', outgoingWorkerId: draft.outgoingWorkerId, from: draft.from, to: draft.to, candidateWorkerIds };
}

/** Quem cobre cada turno, segundo o modo: `string` = pessoa, `null` = "Nadie todavía", `undefined` = ainda sem escolha. */
export function resolveCover(draft: FlowDraft, shifts: PreviewShift[]): Record<string, string | null | undefined> {
  const out: Record<string, string | null | undefined> = {};
  for (const shift of shifts) {
    const key = shiftKey(shift);
    if (draft.coverMode === 'nobody') out[key] = null;
    else if (draft.coverMode === 'one') out[key] = key in draft.dayChoices ? draft.dayChoices[key] : (draft.person ?? undefined);
    else out[key] = key in draft.dayChoices ? draft.dayChoices[key] : undefined;
  }
  return out;
}

/** Os prestadores escolhidos (sem repetição) — o que a pré-visão de conflito precisa perguntar. */
export function chosenWorkers(cover: Record<string, string | null | undefined>): string[] {
  return [...new Set(Object.values(cover).filter((id): id is string => typeof id === 'string'))];
}

export type ShiftConflictView = ConflictState | 'pending';

/** O conflito de um prestador num turno; `pending` = a pré-visão ainda não respondeu (bloqueia como `unknown`, nunca como `free`). */
export function conflictFor(conflicts: PreviewConflict[] | null, workerId: string, shift: Pick<PreviewShift, 'date' | 'slotId'>): { state: ShiftConflictView; conflict: PreviewConflict | null } {
  const found = conflicts?.find((c) => c.workerId === workerId && c.date === shift.date && c.slotId === shift.slotId) ?? null;
  return found === null ? { state: 'pending', conflict: null } : { state: found.state, conflict: found };
}

/** "Siguiente" do passo 3: modo escolhido, todo turno resolvido, e cada pessoa escolhida LIVRE naquele turno (conflito, falha e espera bloqueiam). */
export function canAdvanceCover(draft: FlowDraft, shifts: PreviewShift[], conflicts: PreviewConflict[] | null): boolean {
  if (draft.coverMode === null || shifts.length === 0) return false;
  const cover = resolveCover(draft, shifts);
  return shifts.every((shift) => {
    const who = cover[shiftKey(shift)];
    if (who === undefined) return false;
    return who === null || conflictFor(conflicts, who, shift).state === 'free';
  });
}

/** O corpo do POST de criação (a mesma forma do contrato): turnos com o substituto OBRIGATÓRIO e nullable (P16). */
export function createBody(draft: FlowDraft, shifts: PreviewShift[], destinationAsked: boolean): CreateSubstitutionBody {
  const outgoingWorkerId = draft.outgoingWorkerId as string;
  const reasonCategory = draft.reason;
  if (draft.type === 'PERMANENT') {
    const cover = resolveCover(draft, shifts);
    const first = shifts[0] === undefined ? null : (cover[shiftKey(shifts[0])] ?? null);
    return {
      type: 'PERMANENT',
      outgoingWorkerId,
      from: draft.from,
      reasonCategory,
      substituteWorkerId: first,
      ...(destinationAsked && draft.destination !== '' ? { destination: draft.destination } : {}),
    };
  }
  const cover = resolveCover(draft, shifts);
  const items = shifts.map((s) => ({ date: s.date, slotId: s.slotId, substituteWorkerId: cover[shiftKey(s)] ?? null }));
  return draft.type === 'DAYS'
    ? { type: 'DAYS', outgoingWorkerId, from: draft.from, to: draft.to, reasonCategory, shifts: items }
    : { type: 'ONE_DAY', outgoingWorkerId, from: draft.from, reasonCategory, shifts: items };
}

export type EntraSummary =
  | { kind: 'NOBODY' }
  | { kind: 'PEOPLE'; workerIds: string[]; uncoveredDates: string[] };

/** "Entra" do resumo: ninguém, ou as pessoas escolhidas + os dias em que ninguém entra ("salvo lun 9: nadie") — o mesmo desenho da linha da lista. */
export function summarizeEntra(cover: Record<string, string | null | undefined>, shifts: PreviewShift[]): EntraSummary {
  const workerIds = chosenWorkers(cover);
  if (workerIds.length === 0) return { kind: 'NOBODY' };
  const uncoveredDates = [...new Set(shifts.filter((s) => cover[shiftKey(s)] === null).map((s) => s.date))];
  return { kind: 'PEOPLE', workerIds, uncoveredDates };
}

