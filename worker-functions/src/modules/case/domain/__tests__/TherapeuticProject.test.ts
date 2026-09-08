import { nextMajor, nextMinorOf, sortByCreatedDesc, versionLabel, THERAPEUTIC_CATALOG_KINDS, THERAPEUTIC_CATALOG_TABLE, THERAPEUTIC_CATALOG_RESOURCE } from '../TherapeuticProject';

describe('TherapeuticProject — numeração major.minor (spec 017, D299)', () => {
  it('Novo sem versão nenhuma → 1.0', () => {
    expect(nextMajor([])).toEqual({ major: 1, minor: 0 });
  });

  it('Novo com 1.0, 1.1, 2.0 → 3.0 (a maior major + 1, minor zerada)', () => {
    expect(nextMajor([{ major: 1, minor: 0 }, { major: 1, minor: 1 }, { major: 2, minor: 0 }])).toEqual({ major: 3, minor: 0 });
  });

  it('Editar a 1.0 quando já existe 1.1 → 1.2 (SUP-4: nunca colide, nunca ramifica)', () => {
    const existing = [{ major: 1, minor: 0 }, { major: 1, minor: 1 }, { major: 2, minor: 0 }];
    expect(nextMinorOf(existing, 1)).toEqual({ major: 1, minor: 2 });
    expect(nextMinorOf(existing, 2)).toEqual({ major: 2, minor: 1 });
  });

  it('minors fora de ordem na lista não enganam a redução (1.2 antes de 1.1 → 1.3)', () => {
    expect(nextMinorOf([{ major: 1, minor: 2 }, { major: 1, minor: 1 }, { major: 1, minor: 0 }], 1)).toEqual({ major: 1, minor: 3 });
    expect(nextMajor([{ major: 2, minor: 0 }, { major: 1, minor: 0 }])).toEqual({ major: 3, minor: 0 });
  });

  it('Editar uma major inexistente → M.0 (defensivo; o controller já validou a origem)', () => {
    expect(nextMinorOf([], 7)).toEqual({ major: 7, minor: 0 });
  });

  it('rótulo V.M.m', () => {
    expect(versionLabel(1, 0)).toBe('V.1.0');
    expect(versionLabel(12, 3)).toBe('V.12.3');
  });

  it('lista por data de criação, mais recente primeiro; empate mantém a ordem', () => {
    const out = sortByCreatedDesc([
      { id: 'a', createdAt: '2026-09-01T00:00:00Z' },
      { id: 'b', createdAt: '2026-09-03T00:00:00Z' },
      { id: 'c', createdAt: '2026-09-02T00:00:00Z' },
      { id: 'd', createdAt: '2026-09-03T00:00:00Z' },
    ]);
    expect(out.map((v) => v.id)).toEqual(['b', 'd', 'c', 'a']);
  });

  it('os 3 catálogos têm tabela e recurso de célula próprios (uma célula por catálogo)', () => {
    expect(THERAPEUTIC_CATALOG_KINDS).toHaveLength(3);
    for (const k of THERAPEUTIC_CATALOG_KINDS) {
      expect(THERAPEUTIC_CATALOG_TABLE[k]).toMatch(/^[a-z_]+$/);
      expect(THERAPEUTIC_CATALOG_RESOURCE[k]).toMatch(/^catalog_[a-z_]+$/);
    }
    expect(new Set(Object.values(THERAPEUTIC_CATALOG_RESOURCE)).size).toBe(3);
  });
});
