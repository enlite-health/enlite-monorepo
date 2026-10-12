/**
 * decideLive — a regra do job de 1 minuto (spec 050, F24; A24-2), pura. Um teste por linha da regra.
 * Fixtures sintéticas: instantes relativos à hora marcada (reunião de 45 min).
 */
import { decideLive, type LiveFacts } from '../admissionLive';

const SLOT_START = new Date('2026-10-12T15:00:00.000Z');
const at = (min: number) => new Date(SLOT_START.getTime() + min * 60_000);
const rec = (name: string, startMin: number, endMin: number | null) => ({
  name: `conferenceRecords/${name}`,
  startTime: at(startMin),
  endTime: endMin === null ? null : at(endMin),
});
const facts = (over: Partial<LiveFacts> = {}): LiveFacts => ({
  slotStart: SLOT_START,
  conferenceStartedAt: null,
  conferenceEndedAt: null,
  importStatus: null,
  summaryFastState: null,
  reopenAfterSummaryRecorded: false,
  ...over,
});

describe('decideLive (spec 050 F24)', () => {
  it('R-44: conferência aberta e início nunca gravado → grava o início (o menor)', () => {
    expect(decideLive(facts(), [rec('b', 2, null), rec('a', 1, 1.5)])).toEqual([{ kind: 'record_start', startedAt: at(1) }]);
  });

  it('R-44 (controle): início já gravado igual ao observado → nada; observado mais antigo → regrava', () => {
    expect(decideLive(facts({ conferenceStartedAt: at(1) }), [rec('a', 1, null)])).toEqual([]);
    expect(decideLive(facts({ conferenceStartedAt: at(5) }), [rec('a', 1, null)])).toEqual([{ kind: 'record_start', startedAt: at(1) }]);
  });

  it('R-45: todas fechadas 20 min antes do fim marcado (min 25 de 45) → grava o fim e ARMA', () => {
    expect(decideLive(facts({ conferenceStartedAt: at(0) }), [rec('a', 0, 25)])).toEqual([
      { kind: 'record_end_and_arm', endedAt: at(25), rearm: false },
    ]);
  });

  it('R-45: o fim é o MAIOR endTime entre as conferências fechadas', () => {
    expect(decideLive(facts({ conferenceStartedAt: at(0) }), [rec('a', 0, 12), rec('b', 14, 30)])).toEqual([
      { kind: 'record_end_and_arm', endedAt: at(30), rearm: false },
    ]);
  });

  it('R-56: fim antes de hora marcada + 10 min → grava SEM armar (too_early); controle: aos 30 min de 45 arma', () => {
    expect(decideLive(facts({ conferenceStartedAt: at(-12) }), [rec('a', -12, -10)])).toEqual([
      { kind: 'record_end_no_arm', endedAt: at(-10), reason: 'too_early' },
    ]);
    expect(decideLive(facts({ conferenceStartedAt: at(0) }), [rec('a', 0, 30)])).toEqual([
      { kind: 'record_end_and_arm', endedAt: at(30), rearm: false },
    ]);
  });

  it('R-56 (borda): 1 ms antes de hora marcada + 10 min não arma; NO limite arma', () => {
    const justoAntes = { name: 'conferenceRecords/a', startTime: at(0), endTime: new Date(at(10).getTime() - 1) };
    expect(decideLive(facts({ conferenceStartedAt: at(0) }), [justoAntes])[0].kind).toBe('record_end_no_arm');
    expect(decideLive(facts({ conferenceStartedAt: at(0) }), [rec('a', 0, 10)])[0].kind).toBe('record_end_and_arm');
    // fim DEPOIS da hora marcada mas antes de +10 min (a sala abriu na hora e fechou logo): também não arma
    expect(decideLive(facts({ conferenceStartedAt: at(0) }), [rec('a', 0, 5)])).toEqual([{ kind: 'record_end_no_arm', endedAt: at(5), reason: 'too_early' }]);
  });

  it('R-49: fim gravado + conferência nova aberta, sem resumo → zera o fim e CANCELA o gatilho armado', () => {
    const f = facts({ conferenceStartedAt: at(0), conferenceEndedAt: at(25), importStatus: 'pending', summaryFastState: 'armed' });
    expect(decideLive(f, [rec('a', 0, 25), rec('b', 27, null)])).toEqual([{ kind: 'reopen_and_cancel', cancelTrigger: true }]);
  });

  it('R-49 (controle): reabertura de um fim "cedo demais" (gatilho nunca armado) reabre mas não tem o que cancelar', () => {
    const f = facts({ conferenceStartedAt: at(-12), conferenceEndedAt: at(-10), importStatus: 'pending', summaryFastState: null });
    expect(decideLive(f, [rec('a', -12, -10), rec('b', 0, null)])).toEqual([{ kind: 'reopen_and_cancel', cancelTrigger: false }]);
  });

  it('R-49: depois do cancelamento (fim zerado) a conferência nova fecha → fim regravado e gatilho RE-armado', () => {
    const f = facts({ conferenceStartedAt: at(0), conferenceEndedAt: null, importStatus: 'pending', summaryFastState: 'cancelled' });
    expect(decideLive(f, [rec('a', 0, 25), rec('b', 27, 40)])).toEqual([{ kind: 'record_end_and_arm', endedAt: at(40), rearm: true }]);
  });

  it('R-49: a conferência nova abriu e fechou entre duas rodadas (fim gravado < novo fim) → regrava e rearma', () => {
    const f = facts({ conferenceStartedAt: at(0), conferenceEndedAt: at(25), importStatus: 'pending', summaryFastState: 'armed' });
    expect(decideLive(f, [rec('a', 0, 25), rec('b', 27, 40)])).toEqual([{ kind: 'record_end_and_arm', endedAt: at(40), rearm: true }]);
  });

  it('idempotência: fim já gravado igual ao observado, sem conferência aberta → nada (a 2ª execução não repete)', () => {
    const f = facts({ conferenceStartedAt: at(0), conferenceEndedAt: at(25), importStatus: 'pending', summaryFastState: 'armed' });
    expect(decideLive(f, [rec('a', 0, 25)])).toEqual([]);
  });

  it('R-50: resumo done + conferência nova → SÓ o efeito de reabertura (nenhuma mudança de importação); a 2ª vez não repete', () => {
    const f = facts({ conferenceStartedAt: at(0), conferenceEndedAt: at(25), importStatus: 'done', summaryFastState: 'fired' });
    expect(decideLive(f, [rec('a', 0, 25), rec('b', 60, null)])).toEqual([{ kind: 'reopen_after_summary' }]);
    expect(decideLive({ ...f, reopenAfterSummaryRecorded: true }, [rec('a', 0, 25), rec('b', 60, null)])).toEqual([]);
  });

  it('R-50: com resumo done nem o fim anda quando a conferência nova fecha', () => {
    const f = facts({ conferenceStartedAt: at(0), conferenceEndedAt: at(25), importStatus: 'done', summaryFastState: 'fired' });
    expect(decideLive(f, [rec('a', 0, 25), rec('b', 60, 70)])).toEqual([]);
  });

  it('sem conferência → nada (o no_show é da rede de 15 min, não daqui)', () => {
    expect(decideLive(facts(), [])).toEqual([]);
  });

  it('conferência aberta com fim nunca gravado → só o início (reunião em andamento)', () => {
    expect(decideLive(facts({ conferenceStartedAt: at(0) }), [rec('a', 0, null)])).toEqual([]);
  });
});
