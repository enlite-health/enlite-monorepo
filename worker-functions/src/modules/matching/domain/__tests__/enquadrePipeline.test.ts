import { ENQUADRE_SUMMARY_CELL, canSeeSummary, pipelineOf } from '../enquadrePipeline';

const base = { importStatus: 'done', blockedReason: null, hasSummary: true, unidentifiedCount: 0 };

describe('esteira do evento (T-36c)', () => {
  it('a célula é enquadre_summary:read; null = o engine não decidiu (comportamento inalterado); [] = ator sem célula', () => {
    expect(ENQUADRE_SUMMARY_CELL).toBe('enquadre_summary:read');
    expect(canSeeSummary(null)).toBe(true);
    expect(canSeeSummary([ENQUADRE_SUMMARY_CELL])).toBe(true);
    expect(canSeeSummary([])).toBe(false);
    expect(canSeeSummary(['enquadre_event:read'])).toBe(false);
  });

  it('sem import_status não há esteira', () => {
    expect(pipelineOf({ ...base, importStatus: null }, null)).toBeNull();
  });

  it('o selo do resumo: documento gravado = ready; done sem documento = unavailable; resto = waiting', () => {
    expect(pipelineOf(base, null)?.summary).toBe('ready');
    expect(pipelineOf({ ...base, hasSummary: false }, null)?.summary).toBe('unavailable');
    expect(pipelineOf({ ...base, importStatus: 'waiting', hasSummary: false }, null)?.summary).toBe('waiting');
  });

  it('sem a célula a chave summary não existe; o resto da esteira segue', () => {
    const p = pipelineOf({ ...base, unidentifiedCount: 3 }, []);
    expect(p).toEqual({ importStatus: 'done', blockedReason: null, unidentifiedCount: 3 });
    expect('summary' in (p as object)).toBe(false);
  });

  it('o motivo só vale com blocked', () => {
    expect(pipelineOf({ ...base, importStatus: 'blocked', blockedReason: 'no_link' }, null)?.blockedReason).toBe('no_link');
    expect(pipelineOf({ ...base, importStatus: 'waiting', blockedReason: 'no_link' }, null)?.blockedReason).toBeNull();
  });
});
