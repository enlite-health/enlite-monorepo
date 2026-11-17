import type { DiagnosisEntity, TerminologyPort } from '@modules/terminology/domain/TerminologyPort';
import type { CascadeObjective } from '../../domain/TherapeuticDiagnosisPlan';
import { PlanBlockIncompleteError, PlanBlockWithoutCatalogError, PlanObjectiveInvalidError } from '../../domain/TherapeuticDiagnosisPlan';
import { BuildDiagnosisPlans } from '../buildDiagnosisPlans';
import { DiagnosisUnknownError } from '../pathologySegments';
import type { TherapeuticCatalogCascadePort } from '../ports/TherapeuticCatalogCascadePort';
import { ResolveDiagnosisCategories } from '../resolveDiagnosisCategories';
import { ResolveTherapeuticCatalogCascade } from '../ResolveTherapeuticCatalogCascade';

// Fakes das portas (sem jest.mock de módulo). Códigos e URIs sintéticos, sem dado de paciente.
const CODE_OF: Record<string, string | null> = {
  'urn:a': '6A02.0',
  'urn:b': 'KA00.0/XS2R&XS5W',
  'urn:c': '6A05',
  'urn:nocat': '06',
};

class FakeTerminology implements Pick<TerminologyPort, 'getByUri'> {
  readonly calls: string[] = [];
  async getByUri(uri: string): Promise<DiagnosisEntity | null> {
    this.calls.push(uri);
    const raw = CODE_OF[uri];
    return raw === undefined || raw === null ? null : ({ uri, code: { value: raw } } as unknown as DiagnosisEntity);
  }
}

const obj = (id: string): CascadeObjective => ({
  id,
  label: `obj-${id}`,
  description: null,
  activities: [{ id: `${id}-a1`, label: `act-${id}`, description: null, suggestedFrequency: null }],
});

class FakeCatalog implements TherapeuticCatalogCascadePort {
  readonly asked: Array<{ service: string; categories: readonly string[] }> = [];
  constructor(
    private readonly data: Record<string, Record<string, CascadeObjective[]>>,
    private readonly services: string[],
  ) {}
  async catalogFor(serviceCode: string, categoryCodes: readonly string[]) {
    this.asked.push({ service: serviceCode, categories: categoryCodes });
    const own = this.data[serviceCode] ?? {};
    return new Map(categoryCodes.map((c) => [c, own[c] ?? []] as [string, CascadeObjective[]]));
  }
  async hasCatalog(serviceCode: string) {
    return this.services.includes(serviceCode);
  }
}

const catalog = () => new FakeCatalog({ AT: { '6A02': [obj('o1')], KA00: [], '6A05': [obj('o2')] } }, ['AT']);

describe('ResolveDiagnosisCategories', () => {
  it('resolve URI -> categoria de 4 chars sobre o código CRU (subcódigo e pós-coordenação)', async () => {
    const out = await new ResolveDiagnosisCategories(new FakeTerminology()).execute(['urn:a', 'urn:b', 'urn:c']);
    expect(out.map((c) => c?.value)).toEqual(['6A02', 'KA00', '6A05']);
  });

  it('código sem 4 chars válidos -> null (sem categoria)', async () => {
    const out = await new ResolveDiagnosisCategories(new FakeTerminology()).execute(['urn:nocat']);
    expect(out).toEqual([null]);
  });

  it('URI desconhecida -> DiagnosisUnknownError (422 ptp_diagnosis_unknown)', async () => {
    const run = new ResolveDiagnosisCategories(new FakeTerminology()).execute(['urn:a', 'urn:zzz']);
    await expect(run).rejects.toBeInstanceOf(DiagnosisUnknownError);
    await expect(run).rejects.toMatchObject({ code: 'ptp_diagnosis_unknown' });
  });

  it('URI repetida resolve uma vez e mantém o alinhamento por índice', async () => {
    const t = new FakeTerminology();
    const out = await new ResolveDiagnosisCategories(t).execute(['urn:a', 'urn:c', 'urn:a']);
    expect(out.map((c) => c?.value)).toEqual(['6A02', '6A05', '6A02']);
    expect(t.calls).toEqual(['urn:a', 'urn:c']);
  });
});

describe('ResolveTherapeuticCatalogCascade', () => {
  const make = (c: FakeCatalog) =>
    new ResolveTherapeuticCatalogCascade(new ResolveDiagnosisCategories(new FakeTerminology()), c);

  it('bloco ok / no_catalog / no_category na ordem das URIs; pede só categorias não nulas', async () => {
    const c = catalog();
    const out = await make(c).execute({ serviceCode: 'AT', diagnosisUris: ['urn:a', 'urn:b', 'urn:a'] });
    expect(out.serviceHasCatalog).toBe(true);
    expect(out.blocks.map((b) => [b.diagnosisUri, b.categoryCode, b.status])).toEqual([
      ['urn:a', '6A02', 'ok'],
      ['urn:b', 'KA00', 'no_catalog'],
      ['urn:a', '6A02', 'ok'],
    ]);
    expect(out.blocks[0].objectives.map((o) => o.id)).toEqual(['o1']);
    expect(c.asked[0].categories).toEqual(['6A02', 'KA00']);
  });

  it('no_category: código sem 4 chars (categoryCode null, nenhuma categoria pedida)', async () => {
    const c = catalog();
    const t = new FakeTerminology();
    const uc = new ResolveTherapeuticCatalogCascade(new ResolveDiagnosisCategories(t), c);
    const out = await uc.execute({ serviceCode: 'AT', diagnosisUris: ['urn:nocat'] });
    expect(out.blocks).toEqual([{ diagnosisUri: 'urn:nocat', categoryCode: null, status: 'no_category', objectives: [] }]);
    expect(c.asked[0].categories).toEqual([]);
  });

  it('serviço sem catálogo: serviceHasCatalog false e blocos no_catalog', async () => {
    const out = await make(catalog()).execute({ serviceCode: 'KINE', diagnosisUris: ['urn:a'] });
    expect(out.serviceHasCatalog).toBe(false);
    expect(out.blocks[0]).toMatchObject({ categoryCode: '6A02', status: 'no_catalog', objectives: [] });
  });

  it('URI desconhecida -> 422 e a porta do catálogo não é consultada', async () => {
    const c = catalog();
    await expect(make(c).execute({ serviceCode: 'AT', diagnosisUris: ['urn:zzz'] })).rejects.toBeInstanceOf(DiagnosisUnknownError);
    expect(c.asked).toEqual([]);
  });
});

describe('BuildDiagnosisPlans', () => {
  const make = (c: FakeCatalog) =>
    new BuildDiagnosisPlans(new ResolveDiagnosisCategories(new FakeTerminology()), c);

  it('bloco ok: devolve o snapshot com categoryCode, objetivo e atividade marcados', async () => {
    const out = await make(catalog()).execute('AT', [
      { diagnosisUri: 'urn:a', specificObjectiveIds: ['o1'], activityIds: ['o1-a1'] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ diagnosisUri: 'urn:a', categoryCode: '6A02' });
    expect(out[0].objectives.map((o) => o.id)).toEqual(['o1']);
    expect(out[0].activities.map((a) => a.id)).toEqual(['o1-a1']);
  });

  it('bloco com catálogo sem seleção -> ptp_plan_block_incomplete com o índice', async () => {
    const run = make(catalog()).execute('AT', [
      { diagnosisUri: 'urn:a', specificObjectiveIds: ['o1'], activityIds: ['o1-a1'] },
      { diagnosisUri: 'urn:c', specificObjectiveIds: [], activityIds: [] },
    ]);
    await expect(run).rejects.toBeInstanceOf(PlanBlockIncompleteError);
    await expect(run).rejects.toMatchObject({ diagnosisIndex: 1 });
  });

  it('objetivo fora do catálogo do bloco -> ptp_plan_objective_invalid', async () => {
    const run = make(catalog()).execute('AT', [{ diagnosisUri: 'urn:a', specificObjectiveIds: ['o2'], activityIds: ['o1-a1'] }]);
    await expect(run).rejects.toBeInstanceOf(PlanObjectiveInvalidError);
  });

  it('no_catalog e serviço sem catálogo: seleção tem de vir vazia (senão ptp_plan_block_without_catalog)', async () => {
    const c = catalog();
    await expect(
      make(c).execute('AT', [{ diagnosisUri: 'urn:b', specificObjectiveIds: ['o1'], activityIds: [] }]),
    ).rejects.toBeInstanceOf(PlanBlockWithoutCatalogError);
    const vazio = await make(c).execute('KINE', [{ diagnosisUri: 'urn:a', specificObjectiveIds: [], activityIds: [] }]);
    expect(vazio[0]).toMatchObject({ categoryCode: '6A02', objectives: [], activities: [] });
    await expect(
      make(c).execute('KINE', [{ diagnosisUri: 'urn:a', specificObjectiveIds: ['o1'], activityIds: [] }]),
    ).rejects.toBeInstanceOf(PlanBlockWithoutCatalogError);
  });

  it('URI desconhecida -> DiagnosisUnknownError (422), sem consultar o catálogo', async () => {
    const c = catalog();
    await expect(
      make(c).execute('AT', [{ diagnosisUri: 'urn:zzz', specificObjectiveIds: [], activityIds: [] }]),
    ).rejects.toBeInstanceOf(DiagnosisUnknownError);
    expect(c.asked).toEqual([]);
  });

  it('pede a categoria dos 4 primeiros chars, não o código inteiro (KA00.0/... -> KA00)', async () => {
    const c = catalog();
    await make(c).execute('AT', [{ diagnosisUri: 'urn:b', specificObjectiveIds: [], activityIds: [] }]);
    expect(c.asked[0].categories).toEqual(['KA00']);
  });
});
