import { describe, it, expect } from 'vitest';
import {
  buildJobFilterOptions, matchesJobFilters, normKey, EMPTY_JOB_FILTERS,
  type JobFilterable, type JobFilterSelection,
} from '../jobFilters';
import { buildFixtureJobs, makeT } from './jobFiltersFixture';

const t = makeT('es');
const jobs = buildFixtureJobs();
const count = (sel: Partial<JobFilterSelection>, list: JobFilterable[] = jobs): number =>
  list.filter((j) => matchesJobFilters(j, { ...EMPTY_JOB_FILTERS, ...sel })).length;
const opts = buildJobFilterOptions(jobs, t);
const labelOf = (list: { value: string; label: string }[], value: string): string =>
  list.find((o) => o.value === value)!.label;

describe('fixture sintético reproduz a distribuição medida do feed (18/11)', () => {
  it('177 vagas; 37 sem estado; 4 sem sexo', () => {
    expect(jobs).toHaveLength(177);
    expect(jobs.filter((j) => j.state === null)).toHaveLength(37);
    expect(jobs.filter((j) => j.sex === null)).toHaveLength(4);
  });
});

describe('CA-1 — cada opção de cada filtro devolve >= 1 vaga', () => {
  const cases: Array<[string, keyof JobFilterSelection, keyof typeof opts]> = [
    ['tipo', 'type', 'types'], ['província', 'province', 'provinces'],
    ['localidade', 'locality', 'localities'], ['sexo', 'sex', 'sexes'],
  ];
  it.each(cases)('%s: nenhuma opção morta e a contagem do rótulo é a real', (_n, field, group) => {
    expect(opts[group].length).toBeGreaterThan(0);
    for (const o of opts[group]) {
      const n = count({ [field]: o.value });
      expect(n, `${group}:${o.value}`).toBeGreaterThanOrEqual(1);
      expect(o.label.endsWith(`(${n})`), `${o.label} x ${n}`).toBe(true);
    }
  });

  it.each(cases)('%s: a soma dos grupos = vagas com valor', (_n, field, group) => {
    const soma = opts[group].reduce((acc, o) => acc + count({ [field]: o.value }), 0);
    const comValor = jobs.filter((j) => {
      if (field === 'type') return j.workerTypes.length > 0;
      if (field === 'province') return Boolean(j.state);
      if (field === 'locality') return Boolean(j.city);
      return Boolean(j.sex);
    }).length;
    expect(soma).toBe(comValor);
  });

  it('"Todas" (seleção vazia) = o total', () => {
    expect(count({})).toBe(177);
  });
});

describe('CA-3 — controle positivo: o código antigo mede 0 de 177, o módulo novo mede 177', () => {
  // Réplica do que a tela fazia: opções escritas à mão (getSexOptions/getWorkerTypeOptions/
  // getProvinceOptions) comparadas com `===` ao valor cru do feed.
  const OLD_SEX = ['femenino', 'hombre', 'indistinto', 'mujer'];
  const OLD_TYPE = ['acompañante terapéutico', 'acompañante terapéutico (at)', 'acompañante terapéutico (at) escolar', 'cuidador/a'];
  const OLD_PROVINCE = ['caba', 'provincia de buenos aires', 'provincia de misiones'];
  const oldMatches = (list: string[], pick: (j: JobFilterable) => string | null | undefined): number =>
    jobs.filter((j) => list.some((v) => pick(j) === v)).length;

  it('antigo: 0 em sexo, tipo e província', () => {
    expect(oldMatches(OLD_SEX, (j) => j.sex)).toBe(0);
    expect(oldMatches(OLD_TYPE, (j) => j.workerTypes.join(', '))).toBe(0);
    expect(oldMatches(OLD_PROVINCE, (j) => j.state)).toBe(0);
  });

  it('novo: os grupos cobrem 177 no tipo, 173 no sexo, 140 na província', () => {
    const soma = (g: keyof typeof opts, f: keyof JobFilterSelection): number =>
      opts[g].reduce((a, o) => a + count({ [f]: o.value }), 0);
    expect(soma('types', 'type')).toBe(177);
    expect(soma('sexes', 'sex')).toBe(173);
    expect(soma('provinces', 'province')).toBe(140);
  });
});

describe('normalização (DD-2)', () => {
  it('CABA / caba / " Caba " e Palermo / palermo / " PALERMO " caem num grupo só', () => {
    const lista: JobFilterable[] = ['CABA', 'caba', ' Caba '].map((state) => ({ workerTypes: ['AT'], state }));
    const o = buildJobFilterOptions(lista, t);
    expect(o.provinces).toHaveLength(1);
    expect(o.provinces[0].label.toLowerCase()).toBe('caba (3)'); // empate 1×1×1: a grafia exibida é a primeira em ordem alfabética
    expect(o.provinces[0].value).toBe('caba');
    const palermo = opts.localities.filter((x) => x.value === 'palermo');
    expect(palermo).toHaveLength(1);
    expect(count({ locality: 'palermo' })).toBeGreaterThanOrEqual(3);
  });

  it('acento: Córdoba Capital e Cordoba Capital são o mesmo valor', () => {
    expect(opts.localities.filter((x) => x.value === 'cordoba capital')).toHaveLength(1);
    expect(normKey('Córdoba')).toBe('cordoba');
  });

  it('rótulo = grafia mais frequente do grupo', () => {
    const lista: JobFilterable[] = ['Palermo', 'palermo', 'Palermo'].map((city) => ({ workerTypes: [], city }));
    expect(buildJobFilterOptions(lista, t).localities[0].label).toBe('Palermo (3)');
  });
});

describe('sexo (DD-2, CA-4)', () => {
  it('BOTH → Indistinto, F → Mujer, M → Varón, sem duplicata', () => {
    const labels = opts.sexes.map((o) => o.label.replace(/ \(\d+\)$/, ''));
    expect(labels.sort()).toEqual(['Indistinto', 'Mujer', 'Varón']);
    expect(new Set(opts.sexes.map((o) => o.value)).size).toBe(3);
    expect(labelOf(opts.sexes, 'BOTH')).toBe('Indistinto (79)');
    expect(labelOf(opts.sexes, 'FEMALE')).toBe('Mujer (73)');
    expect(labelOf(opts.sexes, 'MALE')).toBe('Varón (21)');
  });

  it('F e FEMALE são o mesmo grupo', () => {
    const lista: JobFilterable[] = [{ workerTypes: [], sex: 'F' }, { workerTypes: [], sex: 'FEMALE' }];
    expect(buildJobFilterOptions(lista, t).sexes).toHaveLength(1);
  });

  it('sexo nulo só aparece com o filtro em "Todas"', () => {
    const nulos = jobs.filter((j) => j.sex === null);
    expect(nulos).toHaveLength(4);
    for (const v of ['BOTH', 'FEMALE', 'MALE']) expect(count({ sex: v }, nulos)).toBe(0);
    expect(count({}, nulos)).toBe(4);
  });
});

describe('tipo (DD-6)', () => {
  it('AT → Acompañante Terapéutico e CAREGIVER → Cuidador/a, mesmo rótulo do card', () => {
    expect(labelOf(opts.types, 'AT')).toBe('Acompañante Terapéutico (171)');
    expect(labelOf(opts.types, 'CAREGIVER')).toBe('Cuidador/a (6)');
  });

  it('valor desconhecido (NURSE tem rótulo; XPTO não) cai no fallback e nunca some', () => {
    const lista: JobFilterable[] = [{ workerTypes: ['XPTO'] }, { workerTypes: ['NURSE'] }];
    const o = buildJobFilterOptions(lista, t).types;
    expect(o.map((x) => x.label).sort()).toEqual(['Enfermero/a (1)', 'XPTO (1)']);
    expect(count({ type: 'XPTO' }, lista)).toBe(1);
  });
});

describe('vaga sem valor (DD-3)', () => {
  it('sem estado/cidade não entra em nenhuma opção e some ao escolher um valor', () => {
    const sem = jobs.filter((j) => j.state === null);
    expect(sem).toHaveLength(37);
    for (const o of opts.provinces) expect(count({ province: o.value }, sem)).toBe(0);
    for (const o of opts.localities) expect(count({ locality: o.value }, sem)).toBe(0);
    expect(count({}, sem)).toBe(37);
  });

  it('Misiones (0 vagas) não vira opção morta', () => {
    expect(opts.provinces.some((o) => o.value.includes('misiones'))).toBe(false);
  });

  it('filtros combinam por interseção', () => {
    const n = count({ type: 'CAREGIVER', province: 'caba' });
    expect(n).toBe(jobs.filter((j) => j.workerTypes[0] === 'CAREGIVER' && j.state === 'CABA').length);
  });
});
