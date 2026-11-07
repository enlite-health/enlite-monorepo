import { describe, it, expect } from 'vitest';
import { ringLabelElement } from '../mapOverlays';

// ⚑8 (089): contraste AAA do rótulo do anel.
describe('ringLabelElement — contraste (⚑8)', () => {
  it('atual: texto #180149 sobre branco, rosa só em borda e ponto', () => {
    const el = ringLabelElement('5 km', 'current');
    expect(el.style.color).toBe('rgb(24, 1, 73)');
    expect(el.style.background).toBe('rgb(255, 255, 255)');
    expect(el.style.border).toContain('rgb(242, 39, 175)');
    expect(el.querySelector('[data-testid="points-map-ring-dot"]')).not.toBeNull();
  });
  it('concluído: #0A5540 sobre #E1F6EE (7,80:1) com ✓', () => {
    const el = ringLabelElement('5 km', 'done');
    expect(el.style.color).toBe('rgb(10, 85, 64)');
    expect(el.style.background).toBe('rgb(225, 246, 238)');
    expect(el.querySelector('svg')).not.toBeNull();
  });
});
