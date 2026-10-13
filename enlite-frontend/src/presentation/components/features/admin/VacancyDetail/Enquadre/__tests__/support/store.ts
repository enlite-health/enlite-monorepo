/**
 * store — o "servidor" do protótipo: guarda o estado em memória e implementa os 11 métodos de
 * `AdminEnquadreApiService`. É AQUI que se faz o papel do servidor (fase, contagens, `markedCount`, `unmarkedCount`,
 * liberar prestador ao cancelar/encerrar); as telas nunca contam. Só o harness e o teste dos 17 estados importam.
 */
import { AdminEnquadreApiService } from '@infrastructure/http/AdminEnquadreApiService';
import { ApiError } from '@infrastructure/http/ApiError';
import type {
  CreateEnquadreEventInput,
  EnquadreAvailableWorkers,
  EnquadreColumnId,
  EnquadreEventDetail,
  EnquadreEventListItem,
  EnquadreEventPhase,
  EnquadreHostOption,
  EnquadreParticipant,
  EnquadrePipelineState,
  EnquadreWorkerOption,
} from '@domain/entities/EnquadreEvent';
import { FREE_SLOTS, HOSTS } from './fixtures';

/** O evento "cru": só o que o servidor GUARDA; o resto é derivado em `toDetail`. */
export interface SeedEvent {
  id: string;
  startsAt: string;
  endsAt: string;
  hostName: string;
  phase: EnquadreEventPhase;
  meetLink: string | null;
  pipeline: EnquadrePipelineState | null;
  participants: EnquadreParticipant[];
}

export interface Seed {
  events: SeedEvent[];
  available: EnquadreWorkerOption[];
  /** `createEvent` rejeita como se o Google Calendar falhasse (E7). */
  createFails?: boolean;
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const OPEN: ReadonlySet<EnquadreEventPhase> = new Set(['scheduled', 'pending_close']);
const OUTCOME_OF: Partial<Record<EnquadreColumnId, EnquadreParticipant['outcome']>> = {
  SELECTED: 'selected', QUICK_RESPONSE_TEAM: 'quick_response', REJECTED: 'rejected',
};

function toDetail(ev: SeedEvent): EnquadreEventDetail {
  const ps = ev.participants;
  const count = (o: EnquadreParticipant['outcome']): number => ps.filter((p) => p.outcome === o).length;
  return {
    id: ev.id, startsAt: ev.startsAt, endsAt: ev.endsAt, hostName: ev.hostName, country: 'AR', phase: ev.phase, meetLink: ev.meetLink, pipeline: ev.pipeline,
    convokedCount: ps.length,
    markedCount: ps.filter((p) => p.column !== 'CONVOKED').length,
    unmarkedCount: ps.filter((p) => p.column === 'CONVOKED').length,
    outcome: { selected: count('selected'), quickResponse: count('quick_response'), rejected: count('rejected'), returned: count('returned') },
    participants: clone(ps),
  };
}

function toListItem(ev: SeedEvent): EnquadreEventListItem {
  const { participants: _participants, unmarkedCount: _unmarked, ...item } = toDetail(ev);
  return item;
}

const toWorkerOption = (p: EnquadreParticipant): EnquadreWorkerOption => ({ id: p.workerId, name: p.workerName, hasValidEmail: true });

export function createFakeServer(seed: Seed): Record<string, unknown> {
  const events: SeedEvent[] = clone(seed.events);
  let available: EnquadreWorkerOption[] = clone(seed.available);
  let created = 0;

  const find = (id: string): SeedEvent => {
    const ev = events.find((e) => e.id === id);
    if (!ev) throw new Error('evento não encontrado');
    return ev;
  };
  const findOpen = (id: string): SeedEvent => {
    const ev = find(id);
    if (!OPEN.has(ev.phase)) throw new Error('evento fechado');
    return ev;
  };
  const release = (ps: EnquadreParticipant[]): void => { available = [...available, ...ps.map(toWorkerOption)]; };

  return {
    listEvents: async (): Promise<EnquadreEventListItem[]> => events.map(toListItem),
    getEvent: async (_v: string, id: string): Promise<EnquadreEventDetail> => toDetail(find(id)),
    listAvailableWorkers: async (): Promise<EnquadreAvailableWorkers> => ({ workers: clone(available), count: available.length }),
    listHosts: async (): Promise<EnquadreHostOption[]> => clone(HOSTS),
    listHostFreeSlots: async (): Promise<string[]> => [...FREE_SLOTS],
    createEvent: async (_v: string, input: CreateEnquadreEventInput): Promise<EnquadreEventDetail> => {
      if (seed.createFails) throw new ApiError({ success: false, error: 'google calendar', code: 'CALENDAR_CREATE_FAILED' }, 502);
      const chosen = available.filter((w) => input.workerIds.includes(w.id) && w.hasValidEmail);
      const start = new Date(`${input.startsAt}:00-03:00`);
      const end = new Date(start.getTime() + input.durationMinutes * 60_000);
      created += 1;
      const ev: SeedEvent = {
        id: `ev-new-${created}`, startsAt: start.toISOString(), endsAt: end.toISOString(),
        hostName: HOSTS.find((h) => h.id === input.hostId)?.name ?? '', phase: 'scheduled', meetLink: `https://meet.example.test/ev-new-${created}`,
        pipeline: null,
        participants: chosen.map((w) => ({ id: `p-${w.id.slice(2)}`, workerId: w.id, workerName: w.name, occupation: null, column: 'CONVOKED', outcome: null, rejectionReasonCategory: null })),
      };
      events.push(ev);
      available = available.filter((w) => !chosen.some((c) => c.id === w.id));
      return toDetail(ev);
    },
    closeEvent: async (_v: string, id: string): Promise<EnquadreEventDetail> => {
      const ev = find(id);
      if (ev.phase !== 'pending_close') throw new Error('só se encerra evento pendente de encerrar');
      const unmarked = ev.participants.filter((p) => p.column === 'CONVOKED');
      ev.participants.forEach((p) => { p.outcome = OUTCOME_OF[p.column] ?? 'returned'; });
      release(unmarked);
      ev.phase = 'closed';
      ev.meetLink = null;
      ev.pipeline = { importStatus: 'waiting', summary: 'waiting', blockedReason: null };
      return toDetail(ev);
    },
    cancelEvent: async (_v: string, id: string): Promise<EnquadreEventDetail> => {
      const ev = findOpen(id);
      release(ev.participants);
      ev.phase = 'cancelled';
      ev.meetLink = null;
      return toDetail(ev);
    },
    addParticipants: async (_v: string, id: string, workerIds: string[]): Promise<EnquadreEventDetail> => {
      const ev = findOpen(id);
      const chosen = available.filter((w) => workerIds.includes(w.id));
      if (chosen.some((w) => !w.hasValidEmail)) throw new Error('prestador sem e-mail válido');
      chosen.forEach((w) => ev.participants.push({ id: `p-${w.id.slice(2)}`, workerId: w.id, workerName: w.name, occupation: null, column: 'CONVOKED', outcome: null, rejectionReasonCategory: null }));
      available = available.filter((w) => !workerIds.includes(w.id));
      return toDetail(ev);
    },
    removeParticipant: async (_v: string, id: string, participantId: string): Promise<EnquadreEventDetail> => {
      const ev = findOpen(id);
      const out = ev.participants.find((p) => p.id === participantId);
      if (!out) throw new Error('convocado não encontrado');
      // Como o servidor (T-30): quem já foi marcado deixou Convocados e não sai do evento.
      if (out.column !== 'CONVOKED') throw new ApiError({ success: false, error: 'já marcado', code: 'ENQUADRE_PARTICIPANT_ALREADY_MARKED' }, 409);
      ev.participants = ev.participants.filter((p) => p.id !== participantId);
      release([out]);
      return toDetail(ev);
    },
    moveParticipant: async (_v: string, id: string, participantId: string, column: EnquadreColumnId, reason?: string): Promise<EnquadreEventDetail> => {
      const ev = findOpen(id);
      const p = ev.participants.find((x) => x.id === participantId);
      if (!p) throw new Error('convocado não encontrado');
      // Spec §5.2: motivo para ENTRAR e para SAIR de Rejeitados. Quem exige é o servidor (422), como no funil da vaga.
      if (p.column === 'REJECTED' && column !== 'REJECTED' && !reason) {
        throw new ApiError({ success: false, error: 'Falta o motivo', code: 'MOVE_REASON_REQUIRED', reason: 'LEAVE_REJECTED' }, 422);
      }
      if (column === 'REJECTED' && !reason) {
        throw new ApiError({ success: false, error: 'Falta o motivo', code: 'MOVE_REASON_REQUIRED', reason: 'ENTER_REJECTED' }, 422);
      }
      p.column = column;
      p.rejectionReasonCategory = column === 'REJECTED' ? (reason ?? null) : null;
      return toDetail(ev);
    },
  };
}

type Methods = Record<string, unknown>;
let originals: Methods | null = null;

/** Instala o servidor falso sobre o singleton (a técnica da receita de preview). Devolve o desfazer. */
export function installFakeServer(seed: Seed): () => void {
  const target = AdminEnquadreApiService as unknown as Methods;
  const impl = createFakeServer(seed);
  if (!originals) originals = Object.fromEntries(Object.keys(impl).map((k) => [k, target[k]]));
  Object.assign(target, impl);
  return () => { if (originals) Object.assign(target, originals); };
}
