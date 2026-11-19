import type { TFunction } from 'i18next';
import type { ComboboxOption } from '@presentation/components/atoms/Combobox';

/**
 * Filtros da lista de vagas (spec 097): módulo PURO — sem estado, sem I/O.
 *
 * As opções são DERIVADAS dos valores que o feed realmente traz e a comparação é
 * por valor canônico. Antes, as opções eram listas escritas à mão para o scraper
 * legado e comparadas com `===` ("CABA" do feed × "caba" da lista): 0 de 177 casavam.
 */

/** O que o filtro precisa saber de uma vaga (a 096 reusa com o `Job` do `workers/me/jobs`). */
export interface JobFilterable {
  workerTypes: string[];
  state?: string | null;
  city?: string | null;
  sex?: string | null;
}

/** Chave canônica escolhida em cada filtro; `''` = "Todas". */
export interface JobFilterSelection {
  type: string;
  province: string;
  locality: string;
  sex: string;
}

export const EMPTY_JOB_FILTERS: JobFilterSelection = { type: '', province: '', locality: '', sex: '' };

export interface JobFilterOptions {
  types: ComboboxOption[];
  provinces: ComboboxOption[];
  localities: ComboboxOption[];
  sexes: ComboboxOption[];
}

/** Província/localidade: sem acento, sem espaço nas pontas, minúscula (CABA = caba = " Caba "). */
export const normKey = (s: string | null | undefined): string =>
  (s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').trim().toLowerCase();

/** O feed manda `F/M/BOTH`; o enum/locale usa `FEMALE/MALE/BOTH`. */
const SEX_ALIASES: Record<string, string> = { F: 'FEMALE', M: 'MALE' };

export const sexKey = (raw: string | null | undefined): string => {
  const v = (raw ?? '').trim().toUpperCase();
  return SEX_ALIASES[v] ?? v;
};

export const typeKey = (raw: string | null | undefined): string => (raw ?? '').trim().toUpperCase();

interface Group {
  key: string;
  count: number;
  spellings: Map<string, number>;
}

function groupBy(values: string[], keyOf: (v: string) => string): Group[] {
  const groups = new Map<string, Group>();
  for (const raw of values) {
    const key = keyOf(raw);
    if (!key) continue;
    const g = groups.get(key) ?? { key, count: 0, spellings: new Map<string, number>() };
    g.count += 1;
    const shown = raw.trim();
    g.spellings.set(shown, (g.spellings.get(shown) ?? 0) + 1);
    groups.set(key, g);
  }
  return [...groups.values()];
}

/** Grafia mais frequente do grupo (empate: ordem alfabética, para a saída ser estável). */
function dominantSpelling(g: Group): string {
  return [...g.spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'es'))[0][0];
}

const byCountThenLabel = (a: ComboboxOption & { n: number }, b: ComboboxOption & { n: number }): number =>
  b.n - a.n || a.label.localeCompare(b.label, 'es');
const byLabel = (a: ComboboxOption, b: ComboboxOption): number => a.label.localeCompare(b.label, 'es');

const toOptions = (
  groups: Group[],
  labelOf: (g: Group) => string,
  sort: 'count' | 'label',
): ComboboxOption[] => {
  const opts = groups.map((g) => ({ value: g.key, label: `${labelOf(g)} (${g.count})`, n: g.count }));
  const sorted = sort === 'count' ? opts.sort(byCountThenLabel) : opts.sort(byLabel);
  return sorted.map(({ value, label }) => ({ value, label }));
};

/**
 * Opções de cada filtro, só com valores que existem no feed e com a contagem
 * ("Palermo (9)"). A linha "Todas" é do `Combobox` (`clearLabel`), não daqui.
 */
export function buildJobFilterOptions(jobs: JobFilterable[], t: TFunction): JobFilterOptions {
  const types = groupBy(jobs.flatMap((j) => j.workerTypes ?? []), typeKey);
  const sexes = groupBy(jobs.map((j) => j.sex ?? ''), sexKey);
  const provinces = groupBy(jobs.map((j) => j.state ?? ''), normKey);
  const localities = groupBy(jobs.map((j) => j.city ?? ''), normKey);

  return {
    types: toOptions(types, (g) => t(`jobs.profession.${g.key}`, { defaultValue: dominantSpelling(g) }), 'count'),
    sexes: toOptions(sexes, (g) => t(`jobs.sex.${g.key}`, { defaultValue: dominantSpelling(g) }), 'count'),
    provinces: toOptions(provinces, dominantSpelling, 'count'),
    localities: toOptions(localities, dominantSpelling, 'label'),
  };
}

/** Vaga sem valor num campo só aparece quando aquele filtro está em "Todas" (DD-3). */
export function matchesJobFilters(job: JobFilterable, sel: JobFilterSelection): boolean {
  if (sel.type && !(job.workerTypes ?? []).some((w) => typeKey(w) === sel.type)) return false;
  if (sel.province && normKey(job.state) !== sel.province) return false;
  if (sel.locality && normKey(job.city) !== sel.locality) return false;
  if (sel.sex && sexKey(job.sex) !== sel.sex) return false;
  return true;
}
