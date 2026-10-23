import { describe, it, expect } from 'vitest';
import { sortAlphabeticallyEs } from '../alphabeticalOrder';

const L = (...labels: string[]) => labels.map((label) => ({ label }));

describe('sortAlphabeticallyEs', () => {
  it('ordena respeitando Á e Ñ do espanhol', () => {
    const out = sortAlphabeticallyEs(L('Zeta', 'Árbol', 'Ñoño', 'Nube', 'Abeja'));
    expect(out.map((o) => o.label)).toEqual(['Abeja', 'Árbol', 'Nube', 'Ñoño', 'Zeta']);
  });

  it('ordena números por valor (2 antes de 10)', () => {
    const out = sortAlphabeticallyEs(L('Actividad 10', 'Actividad 2'));
    expect(out.map((o) => o.label)).toEqual(['Actividad 2', 'Actividad 10']);
  });

  it('empate por caixa/acento mantém a ordem de entrada', () => {
    const out = sortAlphabeticallyEs([
      { id: 1, label: 'casa' },
      { id: 2, label: 'Casa' },
    ]);
    expect(out.map((o) => o.id)).toEqual([1, 2]);
  });

  it('não muta a entrada', () => {
    const input = L('B', 'A');
    const out = sortAlphabeticallyEs(input);
    expect(out).not.toBe(input);
    expect(input.map((o) => o.label)).toEqual(['B', 'A']);
  });

  it('lista vazia devolve vazia', () => {
    expect(sortAlphabeticallyEs([])).toEqual([]);
  });
});
