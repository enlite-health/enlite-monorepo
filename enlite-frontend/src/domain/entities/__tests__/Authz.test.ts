import { describe, it, expect } from 'vitest';
import { accessLevelFor, hasCell, shouldShowWelcomeNoGroup, featureEnabledFor, type AuthzContract } from '../Authz';

/**
 * A tabela-verdade da regra por componente. É pura de propósito: se ela
 * estiver errada, TODO componente gated está errado, e este é o lugar mais
 * barato para descobrir.
 */
describe('accessLevelFor', () => {
  it.each([
    [null, 'hidden'],
    [[], 'hidden'],
    [['outro:read', 'outro:write'], 'hidden'],
    [['grupo:read'], 'read'],
    [['grupo:write'], 'write'],
    [['grupo:read', 'grupo:write'], 'write'],
    // delete/export/execute NÃO elevam: são ações próprias
    [['grupo:delete'], 'hidden'],
    [['grupo:read', 'grupo:export'], 'read'],
  ] as const)('permissions=%j → %s', (permissions, esperado) => {
    expect(accessLevelFor(permissions as string[] | null, 'grupo')).toBe(esperado);
  });

  it('não casa por prefixo — `grupo_x:write` não é `grupo:write`', () => {
    expect(accessLevelFor(['grupo_x:write', 'grupos:read'], 'grupo')).toBe('hidden');
  });
});

describe('hasCell', () => {
  it('pergunta pela célula exata', () => {
    expect(hasCell(['worker:export'], 'worker', 'export')).toBe(true);
    expect(hasCell(['worker:export'], 'worker', 'delete')).toBe(false);
    expect(hasCell(null, 'worker', 'export')).toBe(false);
  });
});

/** A6 do plano (D268): tabela-verdade completa de A1, pura — 6 linhas nomeadas. */
describe('shouldShowWelcomeNoGroup (A1/D268)', () => {
  const base: AuthzContract = {
    uid: 'u', tenantId: 't', status: 'ACTIVE', permissions: [], countries: [], groups: [{ id: 'g1', name: 'G' }], features: {},
  };

  it('(off, 0 grupos) → painel — enforcement off nunca mostra welcome', () => {
    expect(shouldShowWelcomeNoGroup({ ...base, groups: [], enforcement: 'off' }, 'ready')).toBe(false);
  });

  it('(on, 0 grupos) → welcome', () => {
    expect(shouldShowWelcomeNoGroup({ ...base, groups: [], enforcement: 'on' }, 'ready')).toBe(true);
  });

  it('(on, ≥1 grupo) → painel', () => {
    expect(shouldShowWelcomeNoGroup({ ...base, enforcement: 'on' }, 'ready')).toBe(false);
  });

  it('(loading) → nada muda — não é welcome mesmo com enforcement on e 0 grupos', () => {
    expect(shouldShowWelcomeNoGroup({ ...base, groups: [], enforcement: 'on' }, 'loading')).toBe(false);
    expect(shouldShowWelcomeNoGroup(null, 'loading')).toBe(false);
  });

  it('(error) → não é welcome — a postura de erro já existe em outro lugar', () => {
    expect(shouldShowWelcomeNoGroup({ ...base, groups: [], enforcement: 'on' }, 'error')).toBe(false);
    expect(shouldShowWelcomeNoGroup(null, 'error')).toBe(false);
  });

  it('status !== ACTIVE (com enforcement on e ≥1 grupo) → welcome', () => {
    expect(shouldShowWelcomeNoGroup({ ...base, enforcement: 'on', status: 'SUSPENDED' }, 'ready')).toBe(true);
  });

  it('ausência do campo `enforcement` conta como off', () => {
    expect(shouldShowWelcomeNoGroup({ ...base, groups: [] }, 'ready')).toBe(false);
  });
});

describe('featureEnabledFor (B1/D268)', () => {
  const features = { AR: { 'screen:talentum': { enabled: true, config: null }, 'screen:ana-care': { enabled: false, config: null } } };

  it('mapa ausente/vazio → fail-OPEN (missing-map)', () => {
    expect(featureEnabledFor(undefined, ['AR'], 'screen:talentum')).toEqual({ enabled: true, reason: 'missing-map' });
    expect(featureEnabledFor({}, ['AR'], 'screen:talentum')).toEqual({ enabled: true, reason: 'missing-map' });
    expect(featureEnabledFor({ AR: {} }, ['AR'], 'screen:talentum')).toEqual({ enabled: true, reason: 'missing-map' });
  });

  it('ator sem país único (0 ou >1) → fail-OPEN (no-actor-country)', () => {
    expect(featureEnabledFor(features, [], 'screen:talentum')).toEqual({ enabled: true, reason: 'no-actor-country' });
    expect(featureEnabledFor(features, ['AR', 'BR'], 'screen:talentum')).toEqual({ enabled: true, reason: 'no-actor-country' });
    expect(featureEnabledFor(features, null, 'screen:talentum')).toEqual({ enabled: true, reason: 'no-actor-country' });
  });

  it('mapa presente, chave enabled:false → fail-CLOSED (disabled)', () => {
    expect(featureEnabledFor(features, ['AR'], 'screen:ana-care')).toEqual({ enabled: false, reason: 'disabled' });
  });

  it('chave ausente no mapa do país → fail-OPEN (missing-key)', () => {
    expect(featureEnabledFor(features, ['AR'], 'screen:workers')).toEqual({ enabled: true, reason: 'missing-key' });
  });

  it('mapa presente, chave enabled:true → renderiza (enabled)', () => {
    expect(featureEnabledFor(features, ['AR'], 'screen:talentum')).toEqual({ enabled: true, reason: 'enabled' });
  });
});
