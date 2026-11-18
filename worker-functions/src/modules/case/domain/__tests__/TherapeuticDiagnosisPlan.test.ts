import {
  CascadeObjective,
  CatalogBlock,
  DiagnosisPlan,
  DiagnosisPlans,
  DiagnosisPlanInput,
  PlanActivityInvalidError,
  PlanBlockIncompleteError,
  PlanBlockWithoutCatalogError,
  PlanObjectiveInvalidError,
  classifyBlock,
  flattenDiagnosisPlans,
  validateDiagnosisPlans,
} from '../TherapeuticDiagnosisPlan';

const act = (id: string) => ({ id, label: `atv ${id}`, description: null, suggestedFrequency: null });
const obj = (id: string, activities: string[]): CascadeObjective => ({
  id,
  label: `obj ${id}`,
  description: null,
  activities: activities.map(act),
});
const OBJS = [obj('o1', ['a1', 'a2']), obj('o2', ['a3']), obj('o3', ['a2', 'a4'])];
const block = (cat: string | null = '6A02', objs: CascadeObjective[] = OBJS) => new CatalogBlock(cat, objs);
const input = (o: string[], a: string[], uri = 'u1'): DiagnosisPlanInput => ({
  diagnosisUri: uri,
  specificObjectiveIds: o,
  activityIds: a,
});

describe('classifyBlock (DD-20)', () => {
  it('categoria nula -> no_category; sem objetivo -> no_catalog; com objetivo -> ok', () => {
    expect(classifyBlock(null, OBJS)).toBe('no_category');
    expect(classifyBlock(null, [])).toBe('no_category');
    expect(classifyBlock('6A02', [])).toBe('no_catalog');
    expect(classifyBlock('6A02', OBJS)).toBe('ok');
  });
});

describe('validateDiagnosisPlans (DF-6/DF-7, §9.4)', () => {
  it('bloco válido: snapshot só dos marcados, na ordem do catálogo, com categoryCode', () => {
    const [snap] = validateDiagnosisPlans([input(['o3', 'o1'], ['a4', 'a1'])], [block()]);
    expect(snap.diagnosisUri).toBe('u1');
    expect(snap.categoryCode).toBe('6A02');
    expect(snap.objectives.map((o) => o.id)).toEqual(['o1', 'o3']);
    expect(snap.activities.map((a) => a.id)).toEqual(['a1', 'a4']);
  });

  it('atividade compartilhada por dois objetivos marcados entra uma vez', () => {
    const [snap] = validateDiagnosisPlans([input(['o1', 'o3'], ['a2'])], [block()]);
    expect(snap.activities.map((a) => a.id)).toEqual(['a2']);
  });

  it('objetivo fora do catálogo do bloco -> ptp_plan_objective_invalid com índice e ids', () => {
    const run = () => validateDiagnosisPlans([input(['o1'], ['a1']), input(['zz'], ['a1'], 'u2')], [block(), block()]);
    expect(run).toThrow(PlanObjectiveInvalidError);
    try {
      run();
    } catch (e) {
      const err = e as PlanObjectiveInvalidError;
      expect(err.code).toBe('ptp_plan_objective_invalid');
      expect(err.diagnosisIndex).toBe(1);
      expect(err.ids).toEqual(['zz']);
    }
  });

  it('atividade de objetivo NÃO marcado -> ptp_plan_activity_invalid', () => {
    let caught: unknown;
    try {
      validateDiagnosisPlans([input(['o1'], ['a1', 'a3'])], [block()]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PlanActivityInvalidError);
    expect((caught as PlanActivityInvalidError).code).toBe('ptp_plan_activity_invalid');
    expect((caught as PlanActivityInvalidError).ids).toEqual(['a3']);
  });

  it.each([
    ['sem objetivo', [], ['a1']],
    ['sem atividade', ['o1'], []],
  ])('bloco com catálogo %s -> ptp_plan_block_incomplete', (_n, o, a) => {
    expect(() => validateDiagnosisPlans([input(o, a)], [block()])).toThrow(PlanBlockIncompleteError);
  });

  it.each([
    ['sem categoria', block(null, [])],
    ['sem catálogo', block('6A02', [])],
  ])('bloco %s com seleção -> ptp_plan_block_without_catalog; vazio passa', (_n, b) => {
    let caught: unknown;
    try {
      validateDiagnosisPlans([input([], []), input(['o1'], [], 'u2')], [b, b]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PlanBlockWithoutCatalogError);
    expect((caught as PlanBlockWithoutCatalogError).code).toBe('ptp_plan_block_without_catalog');
    expect((caught as PlanBlockWithoutCatalogError).diagnosisIndex).toBe(1);
    expect(validateDiagnosisPlans([input([], [])], [b])[0]).toMatchObject({ objectives: [], activities: [] });
  });

  it('exige alinhamento entre entradas e blocos', () => {
    expect(() => validateDiagnosisPlans([input(['o1'], ['a1'])], [])).toThrow(RangeError);
  });

  it('o snapshot é congelado', () => {
    const plan = DiagnosisPlan.select(input(['o1'], ['a1']), block());
    expect(Object.isFrozen(plan.snapshot)).toBe(true);
  });
});

describe('flattenDiagnosisPlans / DiagnosisPlans (DD-8)', () => {
  const plans = validateDiagnosisPlans(
    [input(['o1'], ['a1', 'a2']), input(['o1', 'o3'], ['a2', 'a4'], 'u2')],
    [block(), block('6A05')],
  );

  it('une os blocos sem repetir id, na ordem de aparição', () => {
    const flat = flattenDiagnosisPlans(plans);
    expect(flat.specificObjectives.map((o) => o.id)).toEqual(['o1', 'o3']);
    expect(flat.activities.map((a) => a.id)).toEqual(['a1', 'a2', 'a4']);
  });

  it('sameSelectionAs compara por diagnosisUri, ignorando a ordem dos blocos', () => {
    const a = new DiagnosisPlans(plans);
    expect(a.sameSelectionAs(new DiagnosisPlans([...plans].reverse()))).toBe(true);
    const changed = validateDiagnosisPlans(
      [input(['o1'], ['a1', 'a2']), input(['o1'], ['a2'], 'u2')],
      [block(), block('6A05')],
    );
    expect(a.sameSelectionAs(new DiagnosisPlans(changed))).toBe(false);
    expect(a.sameSelectionAs(new DiagnosisPlans(plans.slice(0, 1)))).toBe(false);
  });
});
