import { describe, it, expect } from 'vitest';
import { collidingRingLabels, metersPerPixel } from '../mapOverlays';

describe('collidingRingLabels (089 C)', () => {
  it('enquadramento de 50 km (~7 m/px·km): some o anel de dentro que está a menos de 24 px do vizinho', () => {
    // 50 km = 60 px → 5 km = 6 px, 10 km = 12 px, 20 km = 24 px: o 20 km (36 px do de fora) fica; 10 e 5 somem
    const mpp = 50000 / 60;
    expect([...collidingRingLabels([5, 10, 20, 50], mpp)].sort()).toEqual([0, 1]);
  });
  it('zoom folgado: nada colide', () => {
    expect(collidingRingLabels([5, 10, 20, 50], 20).size).toBe(0);
  });
  it('um anel só, ou escala inválida, nunca esconde', () => {
    expect(collidingRingLabels([5], 100).size).toBe(0);
    expect(collidingRingLabels([5, 10], 0).size).toBe(0);
  });
  it('metersPerPixel cai pela metade a cada zoom e com o cosseno da latitude', () => {
    expect(metersPerPixel(0, 11) / metersPerPixel(0, 12)).toBeCloseTo(2, 6);
    expect(metersPerPixel(60, 10)).toBeCloseTo(metersPerPixel(0, 10) / 2, 3);
  });
});
