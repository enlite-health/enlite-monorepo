import {
  assembleTranscript,
  decideMatch,
  joinParts,
  matchWindow,
  titleHasExactCode,
} from '../admissionImport';
import type { TactiqMeetingItem, TactiqTranscriptPage } from '../../application/ports/TactiqPorts';

const START = new Date('2026-10-09T15:00:00.000Z');
const CODE = 'ADM-7K3Q9P';
const at = (offsetMin: number): string => new Date(START.getTime() + offsetMin * 60_000).toISOString();
const m = (id: string, o: Partial<TactiqMeetingItem> & { offsetMin?: number } = {}): TactiqMeetingItem => ({
  id, title: o.title ?? `${CODE} Admisión`, createdAt: o.createdAt ?? at(o.offsetMin ?? 0), durationSeconds: o.durationSeconds ?? 1800,
});

describe('titleHasExactCode (P1)', () => {
  it('casa o código exato, com qualquer coisa não alfanumérica em volta', () => {
    expect(titleHasExactCode(`${CODE} Admisión`, CODE)).toBe(true);
    expect(titleHasExactCode(`Admisión [${CODE}]`, CODE)).toBe(true);
    expect(titleHasExactCode(CODE, CODE)).toBe(true);
  });

  it('NÃO casa código parecido: o nosso como prefixo ou como sufixo de outro', () => {
    expect(titleHasExactCode(`${CODE}Z Admisión`, CODE)).toBe(false);
    expect(titleHasExactCode(`X${CODE}`, CODE)).toBe(false);
    expect(titleHasExactCode('ADM-7K3Q9 Admisión', CODE)).toBe(false);
    expect(titleHasExactCode('Planning Produto', CODE)).toBe(false);
  });
});

describe('decideMatch (P1 + P3 + unicidade/partes)', () => {
  const base = { code: CODE, slotStart: START };

  it('lista vazia → none/not_found; só títulos sem o código → none/code_mismatch', () => {
    expect(decideMatch({ ...base, items: [] })).toEqual({ kind: 'none', reason: 'not_found' });
    expect(decideMatch({ ...base, items: [m('a', { title: 'Planning' }), m('b', { title: `${CODE}Z` })] })).toEqual({ kind: 'none', reason: 'code_mismatch' });
  });

  it('1 candidata na janela → matched; os limites da janela são inclusivos (−15 min e +60 min)', () => {
    expect(decideMatch({ ...base, items: [m('a')] })).toMatchObject({ kind: 'matched', parts: [{ id: 'a' }] });
    expect(decideMatch({ ...base, items: [m('a', { offsetMin: -15 })] }).kind).toBe('matched');
    expect(decideMatch({ ...base, items: [m('a', { offsetMin: 60 })] }).kind).toBe('matched');
    expect(matchWindow(START).from.toISOString()).toBe(at(-15));
    expect(matchWindow(START).to.toISOString()).toBe(at(60));
  });

  it('fora da janela por 1 minuto, duração 0 ou data inválida → rejected/time_window', () => {
    expect(decideMatch({ ...base, items: [m('a', { offsetMin: -16 })] })).toEqual({ kind: 'rejected', reason: 'time_window' });
    expect(decideMatch({ ...base, items: [m('a', { offsetMin: 61 })] })).toEqual({ kind: 'rejected', reason: 'time_window' });
    expect(decideMatch({ ...base, items: [m('a', { durationSeconds: 0 })] })).toEqual({ kind: 'rejected', reason: 'time_window' });
    expect(decideMatch({ ...base, items: [m('a', { createdAt: 'não é data' })] })).toEqual({ kind: 'rejected', reason: 'time_window' });
  });

  it('uma válida + uma fora da janela → importa só a válida (a de fora não conta como "2 candidatas")', () => {
    expect(decideMatch({ ...base, items: [m('fora', { offsetMin: 300 }), m('ok')] })).toMatchObject({ kind: 'matched', parts: [{ id: 'ok' }] });
  });

  it('2+ SEM sobreposição → partes em ordem cronológica (mesmo se o MCP as entrega trocadas)', () => {
    const r = decideMatch({ ...base, items: [m('p2', { offsetMin: 20, durationSeconds: 900 }), m('p1', { offsetMin: 0, durationSeconds: 600 })] });
    expect(r).toMatchObject({ kind: 'matched' });
    expect((r as { parts: TactiqMeetingItem[] }).parts.map((p) => p.id)).toEqual(['p1', 'p2']);
  });

  it('2+ SOBREPOSTAS → ambiguous; o mesmo id repetido conta uma vez', () => {
    expect(decideMatch({ ...base, items: [m('a', { durationSeconds: 1800 }), m('b', { offsetMin: 10 })] })).toEqual({ kind: 'ambiguous', reason: 'overlap' });
    expect(decideMatch({ ...base, items: [m('a'), m('a')] })).toMatchObject({ kind: 'matched', parts: [{ id: 'a' }] });
  });
});

describe('assembleTranscript (integridade)', () => {
  const page = (n: number, total: number, texts: string[], hasMore = false): TactiqTranscriptPage => ({
    page: n, totalPages: 2, totalChars: total, hasMore,
    entries: texts.map((text, i) => ({ text, speaker: 'Fulana', startSeconds: i * 65, endSeconds: i * 65 + 5 })),
  });

  it('soma dos caracteres = totalChars, páginas em sequência → monta o texto', () => {
    const r = assembleTranscript([page(1, 7, ['abc', 'de'], true), page(2, 7, ['fg'])]);
    expect(r).toEqual({ ok: true, chars: 7, text: '[00:00] Fulana: abc\n[01:05] Fulana: de\n[00:00] Fulana: fg' });
  });

  it('soma diferente, totalChars divergente entre páginas, página fora de ordem, vazio ou total 0 → integrity', () => {
    expect(assembleTranscript([page(1, 8, ['abc', 'de'], true), page(2, 8, ['fg'])])).toEqual({ ok: false, reason: 'integrity' });
    expect(assembleTranscript([page(1, 7, ['abc', 'de'], true), page(2, 9, ['fg'])])).toEqual({ ok: false, reason: 'integrity' });
    expect(assembleTranscript([page(2, 7, ['abc', 'defg'])])).toEqual({ ok: false, reason: 'integrity' });
    expect(assembleTranscript([])).toEqual({ ok: false, reason: 'integrity' });
    expect(assembleTranscript([page(1, 0, [])])).toEqual({ ok: false, reason: 'integrity' });
  });
});

describe('joinParts', () => {
  it('1 parte → o texto puro; várias → cabeçalho por parte, em ordem', () => {
    expect(joinParts([{ meetingId: 'a', text: 'T' }])).toBe('T');
    expect(joinParts([{ meetingId: 'a', text: 'T1' }, { meetingId: 'b', text: 'T2' }])).toBe('=== Parte 1 de 2 · a ===\nT1\n\n=== Parte 2 de 2 · b ===\nT2');
  });
});
