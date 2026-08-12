import {
  applyCaseMemoryPatch,
  normalizeCaseMemory,
  CASE_MEMORY_TRIED_MAX,
  CASE_MEMORY_TEXT_CAP,
  CASE_MEMORY_MISSING_MAX,
  type CaseMemory,
} from '../CaseMemory';

describe('CaseMemory (server-side)', () => {
  describe('applyCaseMemoryPatch', () => {
    it('faz merge parcial: só toca os campos do patch', () => {
      const current: CaseMemory = { stage: 'registered', blocker: 'x' };
      const next = applyCaseMemoryPatch(current, { blocker: 'y' });
      expect(next).toEqual({ stage: 'registered', blocker: 'y' });
    });

    it('ACRESCENTA note a tried com FIFO (máx N)', () => {
      let cm: CaseMemory = {};
      for (let i = 1; i <= CASE_MEMORY_TRIED_MAX + 2; i++) {
        cm = applyCaseMemoryPatch(cm, { note: `intento ${i}` });
      }
      expect(cm.tried).toHaveLength(CASE_MEMORY_TRIED_MAX);
      // manteve os últimos, descartou os primeiros
      expect(cm.tried?.[0]).toBe('intento 3');
      expect(cm.tried?.at(-1)).toBe(`intento ${CASE_MEMORY_TRIED_MAX + 2}`);
    });

    it('ignora stage inválido (não corrompe o dossiê)', () => {
      const next = applyCaseMemoryPatch(
        { stage: 'docs_pending' },
        { stage: 'bogus' },
      );
      expect(next.stage).toBe('docs_pending');
    });

    it('aceita stage válido', () => {
      expect(applyCaseMemoryPatch({}, { stage: 'complete' }).stage).toBe(
        'complete',
      );
    });

    it('substitui missing e limita a MISSING_MAX itens', () => {
      const many = Array.from({ length: CASE_MEMORY_MISSING_MAX + 5 }, (_, i) =>
        String(i),
      );
      const next = applyCaseMemoryPatch({}, { missing: many });
      expect(next.missing).toHaveLength(CASE_MEMORY_MISSING_MAX);
    });

    it('aplica cap de tamanho em textos', () => {
      const long = 'a'.repeat(CASE_MEMORY_TEXT_CAP + 50);
      const next = applyCaseMemoryPatch({}, { blocker: long, note: long });
      expect(next.blocker?.length).toBe(CASE_MEMORY_TEXT_CAP);
      expect(next.tried?.[0].length).toBe(CASE_MEMORY_TEXT_CAP);
    });

    it('ignora textos vazios/whitespace', () => {
      const next = applyCaseMemoryPatch({ blocker: 'keep' }, {
        blocker: '   ',
        note: '',
      });
      expect(next.blocker).toBe('keep');
      expect(next.tried).toBeUndefined();
    });
  });

  describe('normalizeCaseMemory', () => {
    it('descarta lixo e stage inválido', () => {
      expect(
        normalizeCaseMemory({
          stage: 'bogus',
          missing: ['a', 1, 'b'],
          extra: 'ignorar',
          blocker: 'z',
        }),
      ).toEqual({ missing: ['a', 'b'], blocker: 'z' });
    });

    it('devolve {} para entradas não-objeto', () => {
      expect(normalizeCaseMemory(null)).toEqual({});
      expect(normalizeCaseMemory('x')).toEqual({});
    });
  });
});
