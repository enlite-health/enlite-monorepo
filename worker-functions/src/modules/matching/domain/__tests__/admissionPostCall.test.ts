/**
 * decidePostCall — a regra do fim real da call (spec 049 F5, §3.3), pura. A5-1/A5-2 no nível da regra;
 * o e2e prova o efeito no banco.
 */
import { decidePostCall, NO_SHOW_AFTER_START_MS } from '../admissionPostCall';

const START = new Date('2026-10-09T15:00:00.000Z');
const at = (ms: number) => new Date(START.getTime() + ms);
const rec = (name: string, startMin: number, endMin: number | null) => ({
  name,
  startTime: at(startMin * 60_000),
  endTime: endMin === null ? null : at(endMin * 60_000),
});

describe('decidePostCall', () => {
  it('todas as conferências terminadas → fim real = o MAIOR endTime (queda e retorno)', () => {
    const d = decidePostCall({ now: at(120 * 60_000), slotStart: START, records: [rec('conferenceRecords/a', 0, 10), rec('conferenceRecords/b', 14, 55)] });
    expect(d).toEqual({ kind: 'ended', endedAt: at(55 * 60_000), recordNames: ['conferenceRecords/a', 'conferenceRecords/b'] });
  });

  it('uma conferência ainda aberta (sem endTime) → espera, mesmo que a outra parte já tenha terminado', () => {
    expect(decidePostCall({ now: at(90 * 60_000), slotStart: START, records: [rec('conferenceRecords/a', 0, 10), rec('conferenceRecords/b', 14, null)] })).toEqual({ kind: 'wait' });
  });

  it('nenhuma conferência: 1 ms ANTES de slot_start + 1 h espera; NO limite vira no_show', () => {
    expect(decidePostCall({ now: at(NO_SHOW_AFTER_START_MS - 1), slotStart: START, records: [] })).toEqual({ kind: 'wait' });
    expect(decidePostCall({ now: at(NO_SHOW_AFTER_START_MS), slotStart: START, records: [] })).toEqual({ kind: 'no_show' });
  });

  it('com conferência, nunca é no_show — mesmo muito depois da hora marcada', () => {
    expect(decidePostCall({ now: at(10 * NO_SHOW_AFTER_START_MS), slotStart: START, records: [rec('conferenceRecords/a', 0, null)] })).toEqual({ kind: 'wait' });
  });
});
