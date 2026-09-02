import { describe, it, expect } from 'vitest';
import { toDisplayName } from '../displayName';

describe('toDisplayName', () => {
  it('capitaliza o que foi gravado em minúsculas (D249)', () => {
    expect(toDisplayName('flavia villagra')).toBe('Flavia Villagra');
  });

  it('partícula de sobrenome fica minúscula — Title Case ingênuo erraria', () => {
    expect(toDisplayName('maría de los ángeles pérez')).toBe('María de los Ángeles Pérez');
    expect(toDisplayName('joão da silva dos santos')).toBe('João da Silva dos Santos');
  });

  it('partícula na PRIMEIRA posição é capitalizada mesmo assim', () => {
    expect(toDisplayName('da silva')).toBe('Da Silva');
  });

  it('acento sobrevive na inicial (precisa de toLocaleUpperCase)', () => {
    expect(toDisplayName('ángeles')).toBe('Ángeles');
    expect(toDisplayName('joaquín benítez')).toBe('Joaquín Benítez');
  });

  it('nome que já vem capitalizado do ClickUp passa intacto', () => {
    expect(toDisplayName('Juan Pérez')).toBe('Juan Pérez');
  });

  it('CAIXA ALTA vira capitalizado — melhor do que estava', () => {
    expect(toDisplayName('JUAN PÉREZ')).toBe('Juan Pérez');
  });

  it('espaço repetido e pontas soltas somem', () => {
    expect(toDisplayName('  flavia   villagra  ')).toBe('Flavia Villagra');
  });

  it('vazio, só espaço, null e undefined devolvem string vazia', () => {
    for (const e of ['', '   ', null, undefined]) expect(toDisplayName(e)).toBe('');
  });
});
