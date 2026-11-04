import { describe, it, expect, beforeAll } from 'vitest';
import { initI18n, i18n } from './i18nSetup';
import { shiftRangeLabel } from '../shiftRange';

beforeAll(async () => {
  await initI18n('es');
});

describe('shiftRangeLabel — o rótulo único do turno (spec 074)', () => {
  const t = i18n.t.bind(i18n);

  it('L1 08:00 com 1440 vira Todo el día · 24 h', () => {
    expect(shiftRangeLabel(t, { startTime: '08:00', endTime: '08:00', durationMinutes: 1440 })).toBe('Todo el día · 24 h');
  });

  it('L2 08:00 a 08:00 sem duração vira Todo el día · 24 h', () => {
    expect(shiftRangeLabel(t, { startTime: '08:00', endTime: '08:00' })).toBe('Todo el día · 24 h');
  });

  it('L3 20:00 a 08:00 vira 20:00 – 08:00', () => {
    expect(shiftRangeLabel(t, { startTime: '20:00', endTime: '08:00' })).toBe('20:00 – 08:00');
  });

  it('L4 compact: 1440 vira 24 h e 14:00 a 20:00 vira 14–20', () => {
    expect(shiftRangeLabel(t, { startTime: '08:00', endTime: '08:00', durationMinutes: 1440 }, 'compact')).toBe('24 h');
    expect(shiftRangeLabel(t, { startTime: '14:00', endTime: '20:00' }, 'compact')).toBe('14–20');
  });

  it('L5 em pt-BR vira Dia inteiro · 24 h', async () => {
    await i18n.changeLanguage('pt-BR');
    try {
      expect(shiftRangeLabel(i18n.t.bind(i18n), { startTime: '08:00', endTime: '08:00', durationMinutes: 1440 })).toBe('Dia inteiro · 24 h');
    } finally {
      await i18n.changeLanguage('es');
    }
  });
});
