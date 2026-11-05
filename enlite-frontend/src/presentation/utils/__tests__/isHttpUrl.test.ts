import { describe, it, expect } from 'vitest';
import { isHttpUrl } from '../isHttpUrl';

describe('isHttpUrl', () => {
  it.each(['https://go.enlite.health/Xi1G3B', 'http://localhost:3000/x'])('aceita %s', (u) => {
    expect(isHttpUrl(u)).toBe(true);
  });

  it.each([
    '{"id": "link_56rR", "url": "https://go.enlite.health/Xi1G3B"}',
    '',
    '/vacantes/abc',
    'javascript:alert(1)',
    'https;/go.enlite.health/Xi1G3B',
    null,
    undefined,
    42,
  ])('rejeita %s', (u) => {
    expect(isHttpUrl(u)).toBe(false);
  });
});
