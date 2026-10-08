/**
 * vacancyListSort — ordenação da lista de vagas (spec 046 F3, E2).
 *
 * As colunas ordenáveis (contagens do quadro + Última acción + Postulados/Faltantes) são
 * calculadas DEPOIS do SQL (`loadStageCounts`/`loadVacancyActivity`), então com `sort` o
 * controller carrega todas as vagas filtradas, monta o payload de cada uma e ordena AQUI,
 * em memória, sobre esse mesmo payload: o número que ordena é o número que a célula mostra
 * (um dono só). A regra "PRE_SCREENING soma IN_PROGRESS" espelha `VACANCY_FUNNEL_COLUMNS`
 * do front (funnelTabsConfig.ts) — `kanbanColumn.ts` e o Kanban não mudam.
 */
import { emptyFunnelColumnCounts, type FunnelColumnCounts } from '../../domain/kanbanColumn';
import { mapVacancyListRow, type VacancyActivity, type VacancyListRow } from './vacancyListHelpers';
import { projectPatientInVacancy } from '../../application/patientInVacancyProjection';
import { parseSort, type ParsedSort } from '@shared/utils/parseSort';

type ProjectCells = Parameters<typeof projectPatientInVacancy>[1];

export type VacancyListItem = ReturnType<typeof mapVacancyListRow> & {
  stageCounts: FunnelColumnCounts;
  lastActionAt: string | null;
};

/** Monta o item do payload — o MESMO objeto serve ao payload e à ordenação. */
export function buildVacancyListItem(
  row: VacancyListRow,
  cells: ProjectCells,
  stageCounts: FunnelColumnCounts | undefined,
  activity: VacancyActivity | undefined,
): VacancyListItem {
  return {
    ...mapVacancyListRow(projectPatientInVacancy(row, cells)),
    stageCounts: stageCounts ?? emptyFunnelColumnCounts(),
    ...(activity ?? { lastActionAt: null }),
  };
}

type Extractor = (v: VacancyListItem) => number | null;

const column = (...sources: (keyof FunnelColumnCounts)[]): Extractor =>
  (v) => sources.reduce((acc, s) => acc + (v.stageCounts[s] ?? 0), 0);

const fromPaddedString = (s: string | null): number | null => (s === null ? null : Number(s));

/** Allowlist pública (E2). Caso, Status e qualquer dado do paciente ficam FORA. */
export const VACANCY_SORT_ALLOWLIST: Readonly<Record<string, Extractor>> = {
  compatible: column('COMPATIBLE'),
  invited: column('INVITED'),
  iniciado: column('INICIADO'),
  preScreening: column('PRE_SCREENING', 'IN_PROGRESS'),
  completed: column('COMPLETED'),
  selected: column('SELECTED'),
  quickResponseTeam: column('QUICK_RESPONSE_TEAM'),
  rejected: column('REJECTED'),
  postulados: (v) => fromPaddedString(v.postulados),
  faltantes: (v) => fromPaddedString(v.faltantes),
  lastActionAt: (v) => (v.lastActionAt === null ? null : new Date(v.lastActionAt).getTime()),
};

export function parseVacancySort(query: Record<string, unknown>): ParsedSort<Extractor> | null {
  return parseSort(query, VACANCY_SORT_ALLOWLIST);
}

/** Ordena (sem mutar) com NULLS LAST nas duas direções e desempate por id ASC. */
export function sortVacancyItems(items: readonly VacancyListItem[], sort: ParsedSort<Extractor>): VacancyListItem[] {
  const dir = sort.order === 'asc' ? 1 : -1;
  return [...items].sort((a, b) => {
    const va = sort.value(a);
    const vb = sort.value(b);
    if (va !== vb) {
      if (va === null) return 1;
      if (vb === null) return -1;
      return (va - vb) * dir;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
