import { describe, it, expect } from 'vitest';
import { TherapeuticCascade } from '../TherapeuticCascade';
import type { CascadeBlock, CascadeResponse } from '../TherapeuticProject';

const act = (id: string) => ({ id, label: `A ${id}`, description: null, suggestedFrequency: null });
const okBlock = (uri: string): CascadeBlock => ({
  diagnosisUri: uri,
  categoryCode: 'AB12',
  status: 'ok',
  objectives: [
    { id: 'o1', label: 'O1', description: null, activities: [act('a1'), act('a2')] },
    { id: 'o2', label: 'O2', description: null, activities: [act('a3')] },
  ],
});
const emptyBlock = (uri: string, status: 'no_category' | 'no_catalog'): CascadeBlock => ({
  diagnosisUri: uri,
  categoryCode: null,
  status,
  objectives: [],
});
const resp = (blocks: CascadeBlock[], serviceCode = 'AT'): CascadeResponse => ({ serviceCode, serviceHasCatalog: true, blocks });
const loaded = (blocks: CascadeBlock[]) => TherapeuticCascade.empty().chooseService('AT').withCatalog(resp(blocks));

describe('TherapeuticCascade (regra pura, sem React)', () => {
  it('nasce sem serviço, sem blocos e sem seleção (DD-13); passo 2 desabilitado', () => {
    const c = TherapeuticCascade.empty();
    expect(c.serviceCode).toBeNull();
    expect(c.blocks).toEqual([]);
    expect(c.canChooseDiagnoses()).toBe(false);
    expect(c.canSubmit()).toBe(false);
    expect(c.chooseService('AT').canChooseDiagnoses()).toBe(true);
  });

  it('imutável: toggle devolve novo estado e não muda o anterior', () => {
    const a = loaded([okBlock('u1')]);
    const b = a.toggleObjective('u1', 'o1');
    expect(b).not.toBe(a);
    expect(a.isObjectiveSelected('u1', 'o1')).toBe(false);
    expect(b.isObjectiveSelected('u1', 'o1')).toBe(true);
  });

  it('atividade só habilita com objetivo marcado e só mostra as do marcado', () => {
    const c = loaded([okBlock('u1')]);
    expect(c.canPickActivities('u1')).toBe(false);
    expect(c.toggleActivity('u1', 'a1').isActivitySelected('u1', 'a1')).toBe(false);
    const d = c.toggleObjective('u1', 'o1');
    expect(d.canPickActivities('u1')).toBe(true);
    expect(d.activitiesOf('u1').map((a) => a.id)).toEqual(['a1', 'a2']);
    expect(d.toggleActivity('u1', 'a3').isActivitySelected('u1', 'a3')).toBe(false);
  });

  it('desmarcar objetivo tira as atividades dele e mantém as de outro', () => {
    const c = loaded([okBlock('u1')])
      .toggleObjective('u1', 'o1').toggleObjective('u1', 'o2')
      .toggleActivity('u1', 'a1').toggleActivity('u1', 'a3')
      .toggleObjective('u1', 'o1');
    expect(c.isActivitySelected('u1', 'a1')).toBe(false);
    expect(c.isActivitySelected('u1', 'a3')).toBe(true);
  });

  it('trocar o serviço zera blocos e seleção; o mesmo serviço não muda nada', () => {
    const c = loaded([okBlock('u1')]).toggleObjective('u1', 'o1');
    expect(c.chooseService('AT')).toBe(c);
    const d = c.chooseService('OT');
    expect(d.blocks).toEqual([]);
    expect(d.toRequestBody()).toEqual([]);
    expect(d.withCatalog(resp([okBlock('u1')], 'OT')).isObjectiveSelected('u1', 'o1')).toBe(false);
  });

  it('resposta de serviço antigo é ignorada', () => {
    const c = TherapeuticCascade.empty().chooseService('OT');
    expect(c.withCatalog(resp([okBlock('u1')], 'AT'))).toBe(c);
  });

  it('nova resposta mantém a seleção do que sobrou e some com bloco removido', () => {
    const c = loaded([okBlock('u1'), okBlock('u2')]).toggleObjective('u1', 'o1').toggleObjective('u2', 'o2');
    const d = c.withCatalog(resp([okBlock('u2')]));
    expect(d.blocks.map((b) => b.diagnosisUri)).toEqual(['u2']);
    expect(d.isObjectiveSelected('u2', 'o2')).toBe(true);
    expect(d.isObjectiveSelected('u1', 'o1')).toBe(false);
  });

  it('bloco ok exige >=1 objetivo e >=1 atividade; no_catalog/no_category ficam vazios e não aceitam escolha', () => {
    const c = loaded([okBlock('u1'), emptyBlock('u2', 'no_catalog'), emptyBlock('u3', 'no_category')]);
    expect(c.incompleteBlocks()).toEqual(['u1']);
    expect(c.canSubmit()).toBe(false);
    const d = c.toggleObjective('u1', 'o1');
    expect(d.canSubmit()).toBe(false);
    expect(d.toggleActivity('u1', 'a1').canSubmit()).toBe(true);
    expect(c.toggleObjective('u2', 'o1')).toBe(c);
    expect(c.canPickActivities('u2')).toBe(false);
  });

  it('só blocos sem catálogo: salva com tudo vazio; sem blocos não salva', () => {
    expect(loaded([emptyBlock('u2', 'no_catalog')]).canSubmit()).toBe(true);
    expect(loaded([]).canSubmit()).toBe(false);
  });

  it('toRequestBody: diagnosisPlans na ordem dos blocos, ids na ordem do catálogo', () => {
    const c = loaded([okBlock('u1'), emptyBlock('u2', 'no_catalog')])
      .toggleObjective('u1', 'o2').toggleObjective('u1', 'o1')
      .toggleActivity('u1', 'a3').toggleActivity('u1', 'a1');
    expect(c.toRequestBody()).toEqual([
      { diagnosisUri: 'u1', specificObjectiveIds: ['o1', 'o2'], activityIds: ['a1', 'a3'] },
      { diagnosisUri: 'u2', specificObjectiveIds: [], activityIds: [] },
    ]);
  });
});
