import { callProgressOf, type CallProgressFacts } from '../admissionCallProgress';

const T = (h: number, m = 0): Date => new Date(Date.UTC(2026, 9, 12, h, m));
const base: CallProgressFacts = {
  conferenceStartedAt: null,
  conferenceEndedAt: null,
  importStatus: null,
  summaryCreatedAt: null,
  reopenedAfterSummaryAt: null,
};

describe('callProgressOf (F29, §19.3)', () => {
  it('nada observado → none, sem hora', () => {
    expect(callProgressOf(base)).toEqual({ state: 'none', at: null });
  });

  it('início gravado, sem fim → in_progress, hora do início', () => {
    expect(callProgressOf({ ...base, conferenceStartedAt: T(14) })).toEqual({ state: 'in_progress', at: T(14).toISOString() });
  });

  it('fim gravado com import pending → summary_preparing; waiting também', () => {
    const f = { ...base, conferenceStartedAt: T(14), conferenceEndedAt: T(14, 40) };
    expect(callProgressOf({ ...f, importStatus: 'pending' })).toEqual({ state: 'summary_preparing', at: T(14, 40).toISOString() });
    expect(callProgressOf({ ...f, importStatus: 'waiting' }).state).toBe('summary_preparing');
  });

  it('fim cedo sem armar (import_status vazio) → ended, NUNCA summary_preparing', () => {
    const r = callProgressOf({ ...base, conferenceStartedAt: T(14), conferenceEndedAt: T(14, 5), importStatus: null });
    expect(r).toEqual({ state: 'ended', at: T(14, 5).toISOString() });
  });

  it('fim gravado e import terminal sem documento (silêncio, blocked, no_show) → ended', () => {
    for (const s of ['done', 'blocked', 'no_show']) {
      expect(callProgressOf({ ...base, conferenceEndedAt: T(15), importStatus: s }).state).toBe('ended');
    }
  });

  it('documento do resumo existe → summary_ready, hora do DOCUMENTO (não a do fim)', () => {
    const r = callProgressOf({ ...base, conferenceStartedAt: T(14), conferenceEndedAt: T(14, 40), importStatus: 'done', summaryCreatedAt: T(14, 47) });
    expect(r).toEqual({ state: 'summary_ready', at: T(14, 47).toISOString() });
  });

  it('reabriu depois do resumo → reopened_after_summary (ganha do resumo pronto)', () => {
    const r = callProgressOf({
      ...base, conferenceStartedAt: T(14), conferenceEndedAt: T(14, 40), importStatus: 'done',
      summaryCreatedAt: T(14, 47), reopenedAfterSummaryAt: T(15, 2),
    });
    expect(r).toEqual({ state: 'reopened_after_summary', at: T(15, 2).toISOString() });
  });

  it('reabriu ANTES do resumo (fim zerado) → volta a in_progress', () => {
    expect(callProgressOf({ ...base, conferenceStartedAt: T(14), conferenceEndedAt: null, importStatus: null }).state).toBe('in_progress');
  });
});
