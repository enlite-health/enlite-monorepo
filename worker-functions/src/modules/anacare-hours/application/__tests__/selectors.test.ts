import {
  totalHours,
  originCounts,
  validationSummary,
  scheduleDiffMinutes,
  isHoursHighlighted,
  isShiftSelectable,
  HOURS_HIGHLIGHT_THRESHOLD_MINUTES,
} from '../selectors';
import type { AnaCareShift } from '../../domain/AnaCareShift';

function shift(overrides: Partial<AnaCareShift> = {}): AnaCareShift {
  return {
    id: 's1',
    date: '2026-09-10',
    scheduledStart: '2026-09-10T08:00:00.000Z',
    scheduledEnd: '2026-09-10T12:00:00.000Z',
    actualStart: '2026-09-10T08:00:00.000Z',
    actualEnd: '2026-09-10T12:00:00.000Z',
    hoursActual: 4,
    hoursScheduled: 4,
    origin: 'app',
    status: 'pendiente',
    anaCareShiftId: 's1',
    ...overrides,
  };
}

describe('selectors', () => {
  describe('totalHours', () => {
    it('soma hoursActual dos turnos', () => {
      expect(totalHours([shift({ hoursActual: 4 }), shift({ hoursActual: 3 })])).toBe(7);
    });

    it('D344: turno sem check-in (hoursActual null) soma 0h, nunca é ignorado nem quebra a soma', () => {
      expect(totalHours([shift({ hoursActual: 4 }), shift({ hoursActual: null, origin: 'sin_checkin' })])).toBe(4);
    });

    it('lista vazia soma 0', () => {
      expect(totalHours([])).toBe(0);
    });
  });

  describe('originCounts', () => {
    it('conta as 3 origens separadamente', () => {
      const shifts = [
        shift({ origin: 'app' }),
        shift({ origin: 'app' }),
        shift({ origin: 'web_admin' }),
        shift({ origin: 'sin_checkin' }),
      ];
      expect(originCounts(shifts)).toEqual({ app: 2, webAdmin: 1, sinCheckin: 1 });
    });

    it('lista vazia dá zero nas 3', () => {
      expect(originCounts([])).toEqual({ app: 0, webAdmin: 0, sinCheckin: 0 });
    });
  });

  describe('validationSummary', () => {
    it('conta validados, contestados e o total', () => {
      const shifts = [
        shift({ status: 'validado' }),
        shift({ status: 'validado' }),
        shift({ status: 'contestado' }),
        shift({ status: 'pendiente' }),
      ];
      expect(validationSummary(shifts)).toEqual({ validated: 2, contested: 1, total: 4 });
    });
  });

  describe('scheduleDiffMinutes', () => {
    it('retorna a diferença em minutos entre previsto e real', () => {
      const s = shift({ scheduledStart: '2026-09-10T08:00:00.000Z', actualStart: '2026-09-10T08:20:00.000Z' });
      expect(scheduleDiffMinutes(s)).toBe(20);
    });

    it('retorna null quando não há check-in real (actualStart null)', () => {
      expect(scheduleDiffMinutes(shift({ actualStart: null }))).toBeNull();
    });
  });

  describe('isHoursHighlighted (D342: só a partir de 15min, com check-in real)', () => {
    it('destaca com 20 min de diferença e check-in real', () => {
      const s = shift({ scheduledStart: '2026-09-10T08:00:00.000Z', actualStart: '2026-09-10T08:20:00.000Z' });
      expect(isHoursHighlighted(s)).toBe(true);
    });

    it(`não destaca com diferença abaixo de ${HOURS_HIGHLIGHT_THRESHOLD_MINUTES}min`, () => {
      const s = shift({ scheduledStart: '2026-09-10T08:00:00.000Z', actualStart: '2026-09-10T08:10:00.000Z' });
      expect(isHoursHighlighted(s)).toBe(false);
    });

    it('nunca destaca turno sem check-in, mesmo com "diferença" grande', () => {
      expect(isHoursHighlighted(shift({ actualStart: null }))).toBe(false);
    });
  });

  describe('isShiftSelectable', () => {
    it('pendiente e contestado são selecionáveis', () => {
      expect(isShiftSelectable(shift({ status: 'pendiente' }))).toBe(true);
      expect(isShiftSelectable(shift({ status: 'contestado' }))).toBe(true);
    });

    it('validado congela — não selecionável', () => {
      expect(isShiftSelectable(shift({ status: 'validado' }))).toBe(false);
    });
  });
});
