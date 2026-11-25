import { resolveConsentAcceptedAt, CONSENT_MAX_AGE_MS, CONSENT_MAX_SKEW_MS } from '../consentAcceptedAt';

const NOW = new Date('2026-11-24T12:00:00.000Z');
const iso = (deltaMs: number) => new Date(NOW.getTime() + deltaMs).toISOString();

describe('resolveConsentAcceptedAt: janela [agora − 24 h, agora + 5 min]', () => {
  it('hora de poucos minutos atrás vale como veio', () => {
    expect(resolveConsentAcceptedAt(iso(-3 * 60 * 1000), NOW)?.toISOString()).toBe(iso(-3 * 60 * 1000));
  });
  it('limite de 24 h vale; 1 ms além recusa', () => {
    expect(resolveConsentAcceptedAt(iso(-CONSENT_MAX_AGE_MS), NOW)).not.toBeNull();
    expect(resolveConsentAcceptedAt(iso(-CONSENT_MAX_AGE_MS - 1), NOW)).toBeNull();
  });
  it('futuro: até 5 min de relógio adiantado vale, mas é limitado a agora; além recusa', () => {
    expect(resolveConsentAcceptedAt(iso(CONSENT_MAX_SKEW_MS), NOW)?.toISOString()).toBe(NOW.toISOString());
    expect(resolveConsentAcceptedAt(iso(CONSENT_MAX_SKEW_MS + 1), NOW)).toBeNull();
  });
  it('formato ilegível ou sem fuso recusa', () => {
    for (const bad of ['', 'ontem', '2026-11-24', '2026-11-24T11:00:00', '1700000000', '2026-13-45T11:00:00Z']) {
      expect(resolveConsentAcceptedAt(bad, NOW)).toBeNull();
    }
  });
});
