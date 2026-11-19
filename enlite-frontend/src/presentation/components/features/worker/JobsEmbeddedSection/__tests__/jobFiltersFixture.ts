import type { TFunction } from 'i18next';
import type { JobFilterable } from '../jobFilters';
import es from '@infrastructure/i18n/locales/es.json';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';

/**
 * 177 vagas SINTÉTICAS com a distribuição de valores do feed público medida em 18/11/2026
 * (ids e títulos inventados; nenhum dado de paciente):
 *   sexo   BOTH 79 · F 73 · M 21 · nulo 4
 *   tipo   ["AT"] 171 · ["CAREGIVER"] 6
 *   estado CABA 73 · Provincia de Buenos Aires 63 · Córdoba 2 · Neuquén 1 · Mendoza 1 · nulo 37
 *   cidade 37 nulos (os mesmos das vagas sem estado) e o resto em valores sintéticos, com
 *          variações de caixa/acento/espaço no mesmo lugar ("Palermo"/"palermo"/" PALERMO ").
 */
export interface FixtureJob extends JobFilterable {
  id: string;
  title: string;
}

const STATES: Array<[string | null, number]> = [
  ['CABA', 73], ['Provincia de Buenos Aires', 63], ['Córdoba', 2], ['Neuquén', 1], ['Mendoza', 1], [null, 37],
];
const SEXES: Array<[string | null, number]> = [['BOTH', 79], ['F', 73], ['M', 21], [null, 4]];

const expand = <T,>(spec: Array<[T, number]>): T[] => spec.flatMap(([v, n]) => Array<T>(n).fill(v));

export function buildFixtureJobs(): FixtureJob[] {
  const states = expand(STATES);
  const sexes = expand(SEXES);
  const caregiverAt = new Set([3, 40, 77, 101, 130, 160]);
  const cities = Array.from({ length: 70 }, (_, k) => `Barrio Sintetico ${String(k + 1).padStart(2, '0')}`);
  cities[0] = 'Palermo'; cities[1] = 'palermo'; cities[2] = ' PALERMO '; cities[3] = 'Cordoba Capital'; cities[4] = 'Córdoba Capital';
  return states.map((state, i) => ({
    id: `job-sintetico-${i}`,
    title: `CASO SINTETICO ${i}`,
    workerTypes: [caregiverAt.has(i) ? 'CAREGIVER' : 'AT'],
    state,
    city: state === null ? null : cities[i % cities.length],
    // passo 7 é coprimo de 177: espalha os sexos entre estados sem depender da ordem
    sex: sexes[(i * 7) % sexes.length],
  }));
}

/** `t` real sobre o locale (o que o i18next entregaria), com `defaultValue` quando a chave não existe. */
export function makeT(locale: 'es' | 'pt-BR'): TFunction {
  const dict = (locale === 'es' ? es : ptBR) as Record<string, unknown>;
  const t = (key: string, opts?: { defaultValue?: string; [k: string]: unknown }): string => {
    const found = key.split('.').reduce<unknown>((acc, k) => (acc as Record<string, unknown> | undefined)?.[k], dict);
    if (typeof found === 'string') return found.replace(/{{(\w+)}}/g, (_, n: string) => String(opts?.[n] ?? ''));
    return opts?.defaultValue ?? key;
  };
  return t as unknown as TFunction;
}
