import { describe, it, expect, beforeAll } from 'vitest';
import { initI18n, i18n } from './i18nSetup';
import { dayMonthLabel, endTimeOf, fullDayLabel, periodRangeLabel, shiftChipLabel, shortDayLabel, shortWeekday } from '../substitutionLabels';

beforeAll(async () => {
  await initI18n('es');
});

describe('substitutionLabels — textos de data e horário do fluxo e da lista', () => {
  it('chip do turno: "Lun 09 · 09–17" (hora cheia sem minutos; meia hora mantém); sem horário só o dia', () => {
    expect(shiftChipLabel('2026-11-09', '09:00', '17:00', 'es')).toBe('Lun 09 · 09–17');
    expect(shiftChipLabel('2026-11-10', '22:00', '06:30', 'es')).toBe('Mar 10 · 22–06:30');
    expect(shiftChipLabel('2026-11-15', null, null, 'es')).toBe('Dom 15');
    expect(shiftChipLabel('2026-11-09', '09:00', '17:00', 'pt-BR')).toBe('Seg 09 · 09–17');
  });

  it('dia curto minúsculo sem zero: "lun 9"; dia da semana com/sem maiúscula', () => {
    expect(shortDayLabel('2026-11-09', 'es')).toBe('lun 9');
    expect(shortWeekday('2026-11-09', 'es', true)).toBe('Lun');
    expect(shortWeekday('2026-11-09', 'es', false)).toBe('lun');
  });

  it('um dia por extenso: "Martes 3 de noviembre" e "3 de noviembre"', () => {
    expect(fullDayLabel('2026-11-03', 'es')).toBe('Martes 3 de noviembre');
    expect(dayMonthLabel('2026-11-03', 'es')).toBe('3 de noviembre');
  });

  it('período: mesmo mês "9 al 20 de noviembre"; meses diferentes "28 de octubre al 3 de noviembre" (as chaves do seletor de semana)', () => {
    const t = i18n.t.bind(i18n);
    expect(periodRangeLabel(t, '2026-11-09', '2026-11-20', 'es')).toBe('9 al 20 de noviembre');
    expect(periodRangeLabel(t, '2026-10-28', '2026-11-03', 'es')).toBe('28 de octubre al 3 de noviembre');
  });

  it('fim do horário = início + duração (vira o dia, 24 h)', () => {
    expect(endTimeOf('10:00', 240)).toBe('14:00');
    expect(endTimeOf('22:00', 480)).toBe('06:00');
    expect(endTimeOf('09:30', 45)).toBe('10:15');
  });
});
