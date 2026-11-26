import { describe, it, expect } from 'vitest';
import { filterGroupsByWorstSemaphore } from '../patientKanbanSemaphoreFilter';
import type { PatientKanbanItem } from '@domain/entities/PatientDetail';

const p = (id: string, worstSemaphore: PatientKanbanItem['worstSemaphore']): PatientKanbanItem => ({
  id, firstName: 'P', lastName: id, caseNumber: null, dependencyLevel: null, status: 'ACTIVE', admissionStatus: 'DONE', responsibleName: null, worstSemaphore,
});

const groups = {
  ADMISSION: [p('a', 'red'), p('b', 'green')],
  ACTIVE: [p('c', 'yellow'), p('d', null), p('e', undefined)],
  ALTA: [],
};

const ids = (g: Record<string, PatientKanbanItem[]>) => Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v.map((i) => i.id)]));

describe('filterGroupsByWorstSemaphore — o filtro olha worstSemaphore (a cor pronta do servidor), nunca os serviços', () => {
  it('seleção vazia = tudo, o MESMO objeto (sem refazer os grupos)', () => {
    expect(filterGroupsByWorstSemaphore(groups, [])).toBe(groups);
  });

  it('uma cor deixa só os pacientes daquela worstSemaphore, em todas as colunas', () => {
    expect(ids(filterGroupsByWorstSemaphore(groups, ['red']))).toEqual({ ADMISSION: ['a'], ACTIVE: [], ALTA: [] });
  });

  it('multi: união das cores escolhidas; as colunas continuam todas presentes', () => {
    expect(ids(filterGroupsByWorstSemaphore(groups, ['green', 'yellow']))).toEqual({ ADMISSION: ['b'], ACTIVE: ['c'], ALTA: [] });
  });

  it('paciente sem vaga (null) ou sem agregado (undefined) nunca casa com uma cor', () => {
    const r = ids(filterGroupsByWorstSemaphore(groups, ['red', 'yellow', 'green']));
    expect(r.ACTIVE).toEqual(['c']);
  });

  it('não olha os serviços: serviço red num paciente cuja worstSemaphore é green não entra em "red"', () => {
    const q = { ...p('q', 'green'), services: [{ contractedServiceId: 's', serviceCode: 'AT', scheduleHours: 1, reserve: null, cobertas: 0, liveVacancyId: null, semaphore: { n: 0, color: 'red' as const } }] };
    expect(ids(filterGroupsByWorstSemaphore({ X: [q] }, ['red']))).toEqual({ X: [] });
  });
});
