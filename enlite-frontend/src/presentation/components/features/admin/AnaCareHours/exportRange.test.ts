import { describe, it, expect } from 'vitest';
import { MAX_EXPORT_DAYS, isValidRange, rangeDays } from './exportRange';

describe('exportRange (spec 032 — intervalo do diálogo de exportação)', () => {
  it('MAX_EXPORT_DAYS é 62 (mesmo teto do backend, Hasta inclusivo)', () => {
    expect(MAX_EXPORT_DAYS).toBe(62);
  });

  it('rangeDays conta Desde e Hasta INCLUSIVOS', () => {
    expect(rangeDays('2026-09-01', '2026-09-01')).toBe(1);
    expect(rangeDays('2026-09-01', '2026-09-30')).toBe(30);
  });

  it('rangeDays atravessa virada de mês e de ano', () => {
    expect(rangeDays('2026-12-30', '2027-01-02')).toBe(4);
  });

  it('rangeDays devolve null para data inválida ou Hasta < Desde', () => {
    expect(rangeDays('2026-09-10', '2026-09-09')).toBeNull();
    expect(rangeDays('', '2026-09-09')).toBeNull();
    expect(rangeDays('2026-09-01', '')).toBeNull();
  });

  it('POSITIVO — mês cheio e dia único são válidos', () => {
    expect(isValidRange('2026-09-01', '2026-09-30')).toBe(true);
    expect(isValidRange('2026-09-15', '2026-09-15')).toBe(true);
  });

  it('BORDA — 62 dias é válido, 63 não', () => {
    // 2026-08-01 .. 2026-10-01 = 31 + 30 + 1 = 62 dias
    expect(rangeDays('2026-08-01', '2026-10-01')).toBe(62);
    expect(isValidRange('2026-08-01', '2026-10-01')).toBe(true);
    expect(rangeDays('2026-08-01', '2026-10-02')).toBe(63);
    expect(isValidRange('2026-08-01', '2026-10-02')).toBe(false);
  });

  it('NEGATIVO — Hasta anterior a Desde não é válido', () => {
    expect(isValidRange('2026-09-10', '2026-09-09')).toBe(false);
  });

  it('NEGATIVO — vazio e formato errado não passam', () => {
    expect(isValidRange('', '')).toBe(false);
    expect(isValidRange('2026-09-01', '')).toBe(false);
    expect(isValidRange('01/09/2026', '30/09/2026')).toBe(false);
  });

  it('NEGATIVO — data parcial do <input type=date> (ano 0002) não passa', () => {
    expect(isValidRange('0002-09-07', '2026-09-30')).toBe(false);
    expect(isValidRange('2026-09-01', '0002-09-07')).toBe(false);
  });

  it('NEGATIVO — data inexistente (30 de fevereiro) não passa', () => {
    expect(isValidRange('2026-02-30', '2026-03-05')).toBe(false);
  });
});
