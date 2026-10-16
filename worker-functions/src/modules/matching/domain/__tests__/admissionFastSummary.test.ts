/**
 * decideFastRead e isTranscriptReady — o caminho rápido do resumo (spec 050, F24; A24-3), puros. Relógio por parâmetro.
 */
import {
  decideFastRead, isTranscriptReady, FAST_DEADLINE_MS, FAST_FIRST_READ_DELAY_MS, FAST_MAX_READS, FAST_MIN_GAP_MS,
} from '../admissionFastSummary';

const END = new Date('2026-10-12T15:30:00.000Z');
const after = (ms: number) => new Date(END.getTime() + ms);
const MIN = 60_000;

/** Simula a sequência de contagens: lê a cada 60 s a partir de fim + 3 min e devolve em qual leitura (1-based) ficou pronta. */
function leituraPronta(counts: Array<number | null>): number | null {
  let reads = 0;
  let lastReadAt: Date | null = null;
  let previousCount: number | null = null;
  let now = after(FAST_FIRST_READ_DELAY_MS);
  while (true) {
    const d = decideFastRead({ now, endedAt: END, reads, lastReadAt });
    if (d.kind === 'give_up') return null;
    if (d.kind === 'wait') { now = new Date(now.getTime() + 1000); continue; }
    const count = counts[reads];
    reads += 1;
    lastReadAt = now;
    if (isTranscriptReady({ count: count ?? null, previousCount, conferenceOpen: false })) return reads;
    previousCount = count ?? null;
    if (reads >= counts.length) return null;
  }
}

describe('isTranscriptReady (R-51)', () => {
  it('contagens 0, 3, 3 → pronta na 3ª leitura', () => expect(leituraPronta([0, 3, 3])).toBe(3));
  it('contagens 0, 3, 4, 4 → pronta na 4ª', () => expect(leituraPronta([0, 3, 4, 4])).toBe(4));
  it('contagem estável (3, 3) com conferência ABERTA → não pronta', () => {
    expect(isTranscriptReady({ count: 3, previousCount: 3, conferenceOpen: true })).toBe(false);
    expect(isTranscriptReady({ count: 3, previousCount: 3, conferenceOpen: false })).toBe(true);
  });
  it('zero blocos estável (0, 0) não é pronta; reunião não achada no Tactiq (null) não é pronta', () => {
    expect(isTranscriptReady({ count: 0, previousCount: 0, conferenceOpen: false })).toBe(false);
    expect(isTranscriptReady({ count: null, previousCount: null, conferenceOpen: false })).toBe(false);
    expect(isTranscriptReady({ count: 3, previousCount: null, conferenceOpen: false })).toBe(false);
  });
  it('contagem que muda (3 → 4) não é pronta: precisa ser IGUAL à anterior, não só maior que zero', () => {
    expect(isTranscriptReady({ count: 4, previousCount: 3, conferenceOpen: false })).toBe(false);
  });
});

describe('decideFastRead (R-51, R-52)', () => {
  it('nenhuma leitura antes de fim + 3 min; aos 3 min manda ler (controle)', () => {
    expect(decideFastRead({ now: after(FAST_FIRST_READ_DELAY_MS - 1), endedAt: END, reads: null, lastReadAt: null })).toEqual({ kind: 'wait' });
    expect(decideFastRead({ now: after(FAST_FIRST_READ_DELAY_MS), endedAt: END, reads: null, lastReadAt: null })).toEqual({ kind: 'read' });
  });
  it('menos de 60 s da leitura anterior → espera; com 60 s → lê', () => {
    const last = after(3 * MIN);
    expect(decideFastRead({ now: after(3 * MIN + FAST_MIN_GAP_MS - 1), endedAt: END, reads: 1, lastReadAt: last })).toEqual({ kind: 'wait' });
    expect(decideFastRead({ now: after(3 * MIN + FAST_MIN_GAP_MS), endedAt: END, reads: 1, lastReadAt: last })).toEqual({ kind: 'read' });
  });
  it('5 leituras sem ficar pronta → desiste (max_reads), nunca manda a 6ª', () => {
    expect(FAST_MAX_READS).toBe(5);
    expect(decideFastRead({ now: after(8 * MIN), endedAt: END, reads: 4, lastReadAt: after(7 * MIN) })).toEqual({ kind: 'read' });
    expect(decideFastRead({ now: after(8 * MIN), endedAt: END, reads: 5, lastReadAt: after(7 * MIN) })).toEqual({ kind: 'give_up', reason: 'max_reads' });
  });
  it('fim + 10 min → desiste (deadline); 1 ms antes ainda lê', () => {
    expect(decideFastRead({ now: after(FAST_DEADLINE_MS - 1), endedAt: END, reads: 2, lastReadAt: after(5 * MIN) })).toEqual({ kind: 'read' });
    expect(decideFastRead({ now: after(FAST_DEADLINE_MS), endedAt: END, reads: 2, lastReadAt: after(5 * MIN) })).toEqual({ kind: 'give_up', reason: 'deadline' });
  });
  it('contagem que nunca estabiliza esgota as 5 leituras e desiste', () => expect(leituraPronta([1, 2, 3, 4, 5, 6])).toBeNull());
});
