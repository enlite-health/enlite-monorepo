import type { MeetConferenceRecord } from '../application/ports/MeetConferencePort';

/** Passada 1 h da hora marcada sem NENHUMA conferência no Meet: a reunião não aconteceu (`no_show`). */
export const NO_SHOW_AFTER_START_MS = 60 * 60 * 1000;
/** Janela do job: reunião cujo fim passou há mais de 72 h sai do job (o `expired` da importação é da F6). */
export const POST_CALL_WINDOW_HOURS = 72;

export type PostCallDecision =
  | { kind: 'wait' }
  | { kind: 'ended'; endedAt: Date; recordNames: string[] }
  | { kind: 'no_show' };

/**
 * O que a lista de `conferenceRecords` do espaço diz sobre a reunião (spec §3.3), sem I/O:
 *  - nenhuma conferência: até `slot_start + 1 h` ainda pode começar (espera); depois disso é `no_show`;
 *  - alguma conferência ainda aberta (`endTime` ausente): espera, mesmo que outras parte já tenham terminado (queda e retorno);
 *  - todas terminadas: o fim real é o MAIOR `endTime`.
 */
export function decidePostCall(input: { now: Date; slotStart: Date; records: readonly MeetConferenceRecord[] }): PostCallDecision {
  const { now, slotStart, records } = input;
  if (records.length === 0) {
    return now.getTime() >= slotStart.getTime() + NO_SHOW_AFTER_START_MS ? { kind: 'no_show' } : { kind: 'wait' };
  }
  if (records.some((r) => r.endTime === null)) return { kind: 'wait' };
  const endedAt = new Date(Math.max(...records.map((r) => (r.endTime as Date).getTime())));
  return { kind: 'ended', endedAt, recordNames: records.map((r) => r.name) };
}
