import { describe, it, expect } from 'vitest';
import { getInitials } from '../getInitials';

describe('getInitials (achado A6 do gate — util único, ex-duplicado em WorkerAvatar/MessageAvatar)', () => {
  it('2 palavras: 1ª letra de cada, em ordem', () => {
    expect(getInitials('Juan Pérez')).toBe('JP');
  });

  it('3+ palavras: só as 2 PRIMEIRAS (nunca primeira+última)', () => {
    expect(getInitials('QA Staff Um')).toBe('QS');
  });

  it('1 palavra: 1 inicial', () => {
    expect(getInitials('Maria')).toBe('M');
  });

  it('null: "?"', () => {
    expect(getInitials(null)).toBe('?');
  });

  it('undefined: "?"', () => {
    expect(getInitials(undefined)).toBe('?');
  });

  it('string vazia/só espaço: "?"', () => {
    expect(getInitials('   ')).toBe('?');
  });
});
