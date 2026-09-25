import { describe, it, expect } from 'vitest';
import { formatDayMonth, formatDateTime, localeForLanguage } from '../draftVacancyFormat';

describe('draftVacancyFormat — as duas datas da tela do rascunho', () => {
  it('localeForLanguage: "pt-BR" → "pt-BR"; qualquer outra coisa (incl. "es"/undefined) → "es-AR"', () => {
    expect(localeForLanguage('pt-BR')).toBe('pt-BR');
    expect(localeForLanguage('es')).toBe('es-AR');
    expect(localeForLanguage(undefined)).toBe('es-AR');
  });

  it('formatDayMonth: dia + mês por extenso — es-AR por padrão', () => {
    expect(formatDayMonth('2026-09-23T10:00:00.000Z', 'es')).toMatch(/de septiembre/);
  });

  it('formatDayMonth: language "pt-BR" → mês em português', () => {
    expect(formatDayMonth('2026-09-23T10:00:00.000Z', 'pt-BR')).toMatch(/de setembro/);
  });

  it('formatDayMonth: null/undefined/vazio → null, sem lançar', () => {
    expect(formatDayMonth(null, 'es')).toBeNull();
    expect(formatDayMonth(undefined, 'es')).toBeNull();
    expect(formatDayMonth('', 'es')).toBeNull();
  });

  it('formatDayMonth: string inválida → null (catch), não lança', () => {
    expect(formatDayMonth('não-é-uma-data', 'es')).toBeNull();
  });

  it('formatDateTime: dia/mês/ano + hora:minuto em es-AR', () => {
    const out = formatDateTime('2026-09-23T10:05:00.000Z', 'es');
    expect(out).toMatch(/2026/);
    expect(out).toMatch(/:/); // tem hora
  });

  it('formatDateTime: null/undefined/vazio → null, sem lançar', () => {
    expect(formatDateTime(null, 'es')).toBeNull();
    expect(formatDateTime(undefined, 'es')).toBeNull();
    expect(formatDateTime('', 'es')).toBeNull();
  });

  it('formatDateTime: string inválida → null (catch), não lança', () => {
    expect(formatDateTime('não-é-uma-data', 'es')).toBeNull();
  });
});
