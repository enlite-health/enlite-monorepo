import { describe, it, expect } from 'vitest';
import { compareByDistanceKm, type HasDistanceKm } from '../candidateDistance';

describe('compareByDistanceKm', () => {
  it('ordena por km crescente, com sem-distância no fim', () => {
    const items: HasDistanceKm[] = [{ distanceKm: 40 }, { distanceKm: null }, { distanceKm: 3 }, { distanceKm: 12 }];
    const sorted = [...items].sort(compareByDistanceKm);
    expect(sorted.map((i) => i.distanceKm)).toEqual([3, 12, 40, null]);
  });

  it('dois itens sem distância mantêm a ordem de entrada (sort estável)', () => {
    const first: HasDistanceKm = { distanceKm: null };
    const second: HasDistanceKm = { distanceKm: null };
    const items: HasDistanceKm[] = [{ distanceKm: 5 }, first, second];
    const sorted = [...items].sort(compareByDistanceKm);
    expect(sorted[1]).toBe(first);
    expect(sorted[2]).toBe(second);
  });

  it('undefined conta como sem distância, igual a null', () => {
    const items: HasDistanceKm[] = [{ distanceKm: 8 }, { distanceKm: undefined }, { distanceKm: 2 }];
    const sorted = [...items].sort(compareByDistanceKm);
    expect(sorted.map((i) => i.distanceKm)).toEqual([2, 8, undefined]);
  });
});
