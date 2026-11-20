import { ReportDue, sameReportContent, DailyReportTemplate, type ReportContent } from '../DailyReport';

describe('ReportDue — prazo do informe (DC-2)', () => {
  const due = ReportDue.of(new Date('2026-11-16T15:00:00.000Z'));
  it('prazo = fim da guarda + 24 h; aceite até + 7 dias', () => {
    expect(due.dueAt.toISOString()).toBe('2026-11-17T15:00:00.000Z');
    expect(due.acceptUntil.toISOString()).toBe('2026-11-24T15:00:00.000Z');
  });
  it('atraso é DERIVADO: enviado depois do prazo; no instante exato do prazo ainda não é atraso', () => {
    expect(due.isLate(new Date('2026-11-17T15:00:00.000Z'))).toBe(false);
    expect(due.isLate(new Date('2026-11-17T15:00:00.001Z'))).toBe(true);
  });
  it('janela fecha só depois de acceptUntil', () => {
    expect(due.isWindowClosed(new Date('2026-11-24T15:00:00.000Z'))).toBe(false);
    expect(due.isWindowClosed(new Date('2026-11-24T15:00:00.001Z'))).toBe(true);
  });
});

describe('DailyReportTemplate.withoutProject (DC-4)', () => {
  it('molde vazio e sem versão', () => {
    const t = DailyReportTemplate.withoutProject();
    expect(t).toMatchObject({ ptiVersionId: null, objectives: [], activities: [] });
  });
});

describe('sameReportContent', () => {
  const base: ReportContent = {
    workerId: 'w', slotId: 's', onDate: '2026-11-16', ptiVersionId: null, narrative: 'n', narrativeSource: 'TYPED',
    deviceSubmittedAt: new Date('2026-11-17T12:00:00.000Z'), appVersion: '1', answers: [],
  };
  it('igual a si mesmo; difere em qualquer campo escalar', () => {
    expect(sameReportContent(base, { ...base })).toBe(true);
    for (const over of [{ workerId: 'x' }, { slotId: 'x' }, { onDate: '2026-11-17' }, { ptiVersionId: 'p' }, { narrative: 'm' }, { narrativeSource: 'MIXED' as const }, { appVersion: '2' }]) {
      expect(sameReportContent(base, { ...base, ...over })).toBe(false);
    }
  });
  it('contagem e escolha são chaves distintas', () => {
    const c = { itemKind: 'objective' as const, itemId: 'o', scaleCode: 'CNT', answer: { kind: 'count' as const, value: 1 } };
    const ch = { itemKind: 'objective' as const, itemId: 'o', scaleCode: 'CNT', answer: { kind: 'choice' as const, optionCode: '1', reasonCode: null } };
    expect(sameReportContent({ ...base, answers: [c] }, { ...base, answers: [c] })).toBe(true);
    expect(sameReportContent({ ...base, answers: [c] }, { ...base, answers: [ch] })).toBe(false);
  });
});

describe('DailyReportTemplate.validate — catálogo que perdeu a escala do item', () => {
  it('escala do molde ausente do catálogo → scale_mismatch (nunca passa em silêncio)', () => {
    const full = new Map([['SN', { code: 'SN', name: 'n', answeredBy: 'AT' as const, answerKind: 'SINGLE_CHOICE' as const, options: [], reasons: [] }]]);
    const t = DailyReportTemplate.build('v', [{ id: 'o', title: 't', question: 'q', scaleCode: 'SN' }], [], full);
    const answer = { itemKind: 'objective' as const, itemId: 'o', scaleCode: 'SN', answer: { kind: 'choice' as const, optionCode: 'si', reasonCode: null } };
    expect(() => t.validate([answer], new Map())).toThrow('scale_mismatch');
  });
});
