import { canonicalJson, normalizeSnapshot, sameConfig, snapshotHash } from '../snapshot';
import type { IamConfigSnapshot } from '../types';

const bagunçado: IamConfigSnapshot = {
  version: 1,
  tenantId: 't',
  groups: [
    { name: 'Zeta', description: undefined as unknown as null, isSystem: false, cells: ['b:read', 'a:read', 'b:read'], countries: ['br', 'AR'], members: ['B@X.com', ' a@x.com ', 'b@x.com'] },
    { name: 'Alfa', description: 'd', isSystem: true, cells: [], countries: [], members: [] },
  ],
  countryFeatures: [
    { country: 'br', featureKey: 'screen:b', enabled: true, config: undefined as unknown as null },
    { country: 'AR', featureKey: 'screen:z', enabled: false, config: { x: 1 } },
    { country: 'AR', featureKey: 'screen:a', enabled: true, config: null },
  ],
};

describe('normalizeSnapshot', () => {
  it('ordena tudo, deduplica, normaliza caixa de país e e-mail, e preenche null', () => {
    const n = normalizeSnapshot(bagunçado);
    expect(n.groups.map((g) => g.name)).toEqual(['Alfa', 'Zeta']);
    const zeta = n.groups[1];
    expect(zeta.cells).toEqual(['a:read', 'b:read']);
    expect(zeta.countries).toEqual(['AR', 'BR']);
    expect(zeta.members).toEqual(['a@x.com', 'b@x.com']);
    expect(zeta.description).toBeNull();
    expect(n.countryFeatures.map((f) => `${f.country}|${f.featureKey}`)).toEqual(['AR|screen:a', 'AR|screen:z', 'BR|screen:b']);
    expect(n.countryFeatures[2].config).toBeNull();
  });

  it('canonicalJson e o hash são determinísticos — a mesma configuração em ordem diferente dá o mesmo arquivo', () => {
    const invertido: IamConfigSnapshot = { ...bagunçado, groups: [...bagunçado.groups].reverse() };
    expect(canonicalJson(invertido)).toBe(canonicalJson(bagunçado));
    expect(snapshotHash(invertido)).toBe(snapshotHash(bagunçado));
    expect(snapshotHash(bagunçado)).toHaveLength(12);
    expect(canonicalJson(bagunçado).endsWith('\n')).toBe(true);
  });

  it('sameConfig compara por valor, e trata undefined como null', () => {
    expect(sameConfig({ a: 1 }, { a: 1 })).toBe(true);
    expect(sameConfig({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameConfig(undefined, null)).toBe(true);
  });
});
