import { describe, it, expect } from 'vitest';
import { buildJobFilterOptions } from '../jobFilters';
import { buildFixtureJobs, makeT } from './jobFiltersFixture';
import es from '@infrastructure/i18n/locales/es.json';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';

const NEW_KEYS = [
  'filters.allWorkerTypes', 'filters.allProvinces', 'filters.allLocalities', 'filters.allSexes',
  'ageRange.between', 'ageRange.from', 'ageRange.upTo',
];
const get = (d: unknown, path: string): unknown =>
  `jobs.${path}`.split('.').reduce<unknown>((a, k) => (a as Record<string, unknown> | undefined)?.[k], d);
const bare = (label: string): string => label.replace(/ \(\d+\)$/, '');

describe('i18n dos filtros de vagas (CA-4/CA-5)', () => {
  it.each([['es', es], ['pt-BR', ptBR]])('%s tem todas as chaves novas', (_l, dict) => {
    for (const k of NEW_KEYS) expect(typeof get(dict, k), k).toBe('string');
  });

  it.each([
    ['es', ['Indistinto', 'Mujer', 'Varón'], ['Acompañante Terapéutico', 'Cuidador/a']],
    ['pt-BR', ['Homem', 'Indiferente', 'Mulher'], ['Acompanhante Terapêutico', 'Cuidador(a)']],
  ] as const)('%s: rótulos de sexo e tipo vêm do locale, sem duplicata', (loc, sexos, tipos) => {
    const o = buildJobFilterOptions(buildFixtureJobs(), makeT(loc));
    expect(o.sexes.map((x) => bare(x.label)).sort()).toEqual([...sexos].sort());
    expect(o.types.map((x) => bare(x.label)).sort()).toEqual([...tipos].sort());
  });

  it('faixa etária sai por chave, em es e pt-BR', () => {
    expect(makeT('es')('jobs.ageRange.between', { min: 20, max: 30 })).toBe('20 a 30 años');
    expect(makeT('pt-BR')('jobs.ageRange.upTo', { max: 60 })).toBe('até 60 anos');
  });
});
