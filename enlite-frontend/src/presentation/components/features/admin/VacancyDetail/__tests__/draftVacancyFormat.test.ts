import { describe, it, expect } from 'vitest';
import { formatDayMonth, formatDateTime } from '../draftVacancyFormat';

describe('draftVacancyFormat — as duas datas da tela do rascunho', () => {
  it('formatDayMonth: dia + mês por extenso em es-AR', () => {
    expect(formatDayMonth('2026-09-23T10:00:00.000Z')).toMatch(/de septiembre/);
  });

  it('formatDayMonth: null/undefined/vazio → null, sem lançar', () => {
    expect(formatDayMonth(null)).toBeNull();
    expect(formatDayMonth(undefined)).toBeNull();
    expect(formatDayMonth('')).toBeNull();
  });

  it('formatDayMonth: string inválida → null (catch), não lança', () => {
    expect(formatDayMonth('não-é-uma-data')).toBeNull();
  });

  it('formatDateTime: dia/mês/ano + hora:minuto em es-AR', () => {
    const out = formatDateTime('2026-09-23T10:05:00.000Z');
    expect(out).toMatch(/2026/);
    expect(out).toMatch(/:/); // tem hora
  });

  it('formatDateTime: null/undefined/vazio → null, sem lançar', () => {
    expect(formatDateTime(null)).toBeNull();
    expect(formatDateTime(undefined)).toBeNull();
    expect(formatDateTime('')).toBeNull();
  });

  it('formatDateTime: string inválida → null (catch), não lança', () => {
    expect(formatDateTime('não-é-uma-data')).toBeNull();
  });
});
