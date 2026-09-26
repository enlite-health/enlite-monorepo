export type VacancyFunnelColumnId =
  | 'INVITED'
  | 'INICIADO'
  | 'PRE_SCREENING'
  | 'COMPLETED'
  | 'CONFIRMED'
  | 'SELECTED'
  | 'REJECTED';

export interface VacancyFunnelColumn {
  id: VacancyFunnelColumnId;
  sources: readonly string[];
  color: string;
  droppable: boolean;
}

/** Quadro B (D433): 7 colunas nesta fase; Fases 4 e 5 acrescentam Equipe de Resposta Rápida e Compatíveis. */
export const VACANCY_FUNNEL_COLUMNS: readonly VacancyFunnelColumn[] = [
  { id: 'INVITED', sources: ['INVITED'], color: 'bg-blue-400', droppable: true },
  { id: 'INICIADO', sources: ['INICIADO'], color: 'bg-indigo-400', droppable: false },
  { id: 'PRE_SCREENING', sources: ['PRE_SCREENING', 'IN_PROGRESS'], color: 'bg-violet-400', droppable: false },
  { id: 'COMPLETED', sources: ['COMPLETED'], color: 'bg-violet-600', droppable: false },
  { id: 'CONFIRMED', sources: ['CONFIRMED'], color: 'bg-cyan-400', droppable: true },
  { id: 'SELECTED', sources: ['SELECTED'], color: 'bg-green-500', droppable: true },
  { id: 'REJECTED', sources: ['REJECTED'], color: 'bg-red-400', droppable: true },
];

export function columnItems<T>(col: VacancyFunnelColumn, stages: Partial<Record<string, T[]>>): T[] {
  return col.sources.flatMap((s) => stages[s] ?? []);
}

export function columnCount(col: VacancyFunnelColumn, counts: Partial<Record<string, number>> | undefined): number {
  return col.sources.reduce((acc, s) => acc + (counts?.[s] ?? 0), 0);
}

export type FunnelTab =
  | { key: 'ALL'; kind: 'bucket'; bucket: 'ALL'; i18nKey: string }
  | { key: VacancyFunnelColumnId; kind: 'column'; column: VacancyFunnelColumn; i18nKey: string }
  | { key: 'POSTULATED' | 'PRE_SELECTED' | 'WITHDREW'; kind: 'bucket'; bucket: 'POSTULATED' | 'PRE_SELECTED' | 'WITHDREW'; i18nKey: string };

export const FUNNEL_TABS: readonly FunnelTab[] = [
  { key: 'ALL', kind: 'bucket', bucket: 'ALL', i18nKey: 'admin.vacancyDetail.funnelTabs.all' },
  ...VACANCY_FUNNEL_COLUMNS.map((c) => ({ key: c.id, kind: 'column' as const, column: c, i18nKey: `admin.kanban.columns.${c.id}` })),
  { key: 'POSTULATED', kind: 'bucket', bucket: 'POSTULATED', i18nKey: 'admin.vacancyDetail.funnelTabs.postulated' },
  { key: 'PRE_SELECTED', kind: 'bucket', bucket: 'PRE_SELECTED', i18nKey: 'admin.vacancyDetail.funnelTabs.preSelected' },
  { key: 'WITHDREW', kind: 'bucket', bucket: 'WITHDREW', i18nKey: 'admin.vacancyDetail.funnelTabs.withdrew' },
];
