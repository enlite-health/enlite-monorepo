import {
  nextMajor,
  nextMinorOf,
  sortByCreatedDesc,
  versionLabel,
  THERAPEUTIC_CATALOG_KINDS,
  THERAPEUTIC_CATALOG_TABLE,
  THERAPEUTIC_CATALOG_RESOURCE,
  THERAPEUTIC_FIELD_CLASS,
  macroFieldsChanged,
  currentVersionOf,
} from '../TherapeuticProject';

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

  it('os 3 catálogos (US-17: segments entrou na 430) têm tabela e recurso de célula próprios; "tipo de patologia" NÃO é catálogo (deriva do CID-11)', () => {
    expect(THERAPEUTIC_CATALOG_KINDS).toHaveLength(3);
    expect(THERAPEUTIC_CATALOG_KINDS).toContain('segments');
    expect(THERAPEUTIC_CATALOG_KINDS).not.toContain('pathology-types');
    for (const k of THERAPEUTIC_CATALOG_KINDS) {
      expect(THERAPEUTIC_CATALOG_TABLE[k]).toMatch(/^[a-z_]+$/);
      expect(THERAPEUTIC_CATALOG_RESOURCE[k]).toMatch(/^catalog_[a-z_]+$/);
    }
    expect(new Set(Object.values(THERAPEUTIC_CATALOG_RESOURCE)).size).toBe(3);
    expect(THERAPEUTIC_CATALOG_TABLE.segments).toBe('therapeutic_segments');
    expect(THERAPEUTIC_CATALOG_RESOURCE.segments).toBe('catalog_therapeutic_segments');
  });
});

describe('THERAPEUTIC_FIELD_CLASS — modality é MICRO (D328/SUP-24)', () => {
  it('modality nunca está em MACRO; contactRefs/careTeamIds também são MICRO', () => {
    expect(THERAPEUTIC_FIELD_CLASS.MACRO).not.toContain('modality');
    expect(THERAPEUTIC_FIELD_CLASS.MICRO).toContain('modality');
    expect(THERAPEUTIC_FIELD_CLASS.MICRO).toContain('contactRefs');
    expect(THERAPEUTIC_FIELD_CLASS.MICRO).toContain('careTeamIds');
  });

  it('MACRO e MICRO não se sobrepõem', () => {
    const macro = new Set(THERAPEUTIC_FIELD_CLASS.MACRO);
    const overlap = THERAPEUTIC_FIELD_CLASS.MICRO.filter((f) => macro.has(f as never));
    expect(overlap).toEqual([]);
  });
});

describe('macroFieldsChanged — ADR-4/D328: mode:edit recusa mudar MACRO', () => {
  const current = {
    contractedServiceId: 'svc-1',
    diagnosisUris: ['uri-a', 'uri-b'],
    clinicalContext: 'contexto',
    generalObjective: 'objetivo',
    specificObjectiveIds: ['so-1', 'so-2'],
    activityIds: ['act-1'],
  };
  const sameCandidate = {
    contractedServiceId: 'svc-1',
    diagnoses: [{ uri: 'uri-b' }, { uri: 'uri-a' }], // ordem trocada — mesmo conjunto
    clinicalContext: 'contexto',
    generalObjective: 'objetivo',
    specificObjectiveIds: ['so-2', 'so-1'], // ordem trocada — mesmo conjunto
    activityIds: ['act-1'],
  };

  it('candidato idêntico (mesmo conjunto, ordem livre) → nada mudou', () => {
    expect(macroFieldsChanged(current, sameCandidate)).toEqual([]);
  });

  it('cada campo MACRO alterado isoladamente aparece sozinho na lista', () => {
    expect(macroFieldsChanged(current, { ...sameCandidate, contractedServiceId: 'svc-2' })).toEqual(['contractedServiceId']);
    expect(macroFieldsChanged(current, { ...sameCandidate, diagnoses: [{ uri: 'uri-c' }] })).toEqual(['diagnoses']);
    expect(macroFieldsChanged(current, { ...sameCandidate, clinicalContext: 'outro' })).toEqual(['clinicalContext']);
    expect(macroFieldsChanged(current, { ...sameCandidate, generalObjective: 'outro' })).toEqual(['generalObjective']);
    expect(macroFieldsChanged(current, { ...sameCandidate, specificObjectiveIds: ['so-3'] })).toEqual(['specificObjectiveIds']);
    expect(macroFieldsChanged(current, { ...sameCandidate, activityIds: ['act-2'] })).toEqual(['activityIds']);
  });

  it('vários campos mudando de uma vez aparecem todos (para o 422 {fields:[...]} nomear todos)', () => {
    expect(
      macroFieldsChanged(current, { ...sameCandidate, contractedServiceId: 'svc-2', clinicalContext: 'outro' }),
    ).toEqual(['contractedServiceId', 'clinicalContext']);
  });

  it('diagnoses com o mesmo tamanho mas conjunto diferente conta como mudança (não só length)', () => {
    expect(macroFieldsChanged(current, { ...sameCandidate, diagnoses: [{ uri: 'uri-a' }, { uri: 'uri-c' }] })).toEqual(['diagnoses']);
  });
});

describe('currentVersionOf — vigente = created_at mais recente entre as não-anuladas (D328)', () => {
  it('lista vazia → null', () => {
    expect(currentVersionOf([])).toBeNull();
  });

  it('todas anuladas → null', () => {
    expect(
      currentVersionOf([
        { id: 'a', createdAt: '2026-09-01T00:00:00Z', annulledAt: '2026-09-02T00:00:00Z' },
        { id: 'b', createdAt: '2026-09-03T00:00:00Z', annulledAt: '2026-09-04T00:00:00Z' },
      ]),
    ).toBeNull();
  });

  it('a mais recente NÃO anulada vence, mesmo que a major seja menor (regra é por DATA)', () => {
    const out = currentVersionOf([
      { id: 'v1.0', createdAt: '2026-09-01T00:00:00Z', annulledAt: null },
      { id: 'v2.0', createdAt: '2026-09-03T00:00:00Z', annulledAt: '2026-09-05T00:00:00Z' }, // anulada — não conta
      { id: 'v1.1', createdAt: '2026-09-02T00:00:00Z', annulledAt: null },
    ]);
    expect(out?.id).toBe('v1.1');
  });
});
