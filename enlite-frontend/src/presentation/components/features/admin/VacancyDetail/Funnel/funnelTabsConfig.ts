export type VacancyFunnelColumnId =
  | 'COMPATIBLE'
  | 'INVITED'
  | 'INICIADO'
  | 'PRE_SCREENING'
  | 'BLOQUEADO'
  | 'COMPLETED'
  | 'SELECTED'
  | 'QUICK_RESPONSE_TEAM'
  | 'REJECTED';

export interface VacancyFunnelColumn {
  id: VacancyFunnelColumnId;
  sources: readonly string[];
  color: string;
  droppable: boolean;
  /** Soltar com o ponteiro sobre a coluna cancela o drop (FR-06 da 067): não cai na coluna vizinha pelo closestCenter (P20b). */
  cancelDrop?: boolean;
}

/**
 * Quadro B (D433): 9 colunas (052: o estágio Confirmado saiu); Compatíveis (Fase 5) é derivada do match, só leitura.
 * 067: Bloqueados (Completado cujo prestador não está apto) vem imediatamente antes de Completado e é só leitura:
 * o card sai de lá quando o prestador fica apto, não por arrasto.
 */
export const VACANCY_FUNNEL_COLUMNS: readonly VacancyFunnelColumn[] = [
  { id: 'COMPATIBLE', sources: ['COMPATIBLE'], color: 'bg-slate-400', droppable: false },
  { id: 'INVITED', sources: ['INVITED'], color: 'bg-blue-400', droppable: true },
  { id: 'INICIADO', sources: ['INICIADO'], color: 'bg-indigo-400', droppable: false },
  { id: 'PRE_SCREENING', sources: ['PRE_SCREENING', 'IN_PROGRESS'], color: 'bg-violet-400', droppable: false },
  { id: 'BLOQUEADO', sources: ['BLOQUEADO'], color: 'bg-amber-500', droppable: false, cancelDrop: true },
  { id: 'COMPLETED', sources: ['COMPLETED'], color: 'bg-violet-600', droppable: false },
  { id: 'SELECTED', sources: ['SELECTED'], color: 'bg-green-500', droppable: true },
  { id: 'QUICK_RESPONSE_TEAM', sources: ['QUICK_RESPONSE_TEAM'], color: 'bg-teal-500', droppable: true },
  { id: 'REJECTED', sources: ['REJECTED'], color: 'bg-red-400', droppable: true },
];

export function columnItems<T>(col: VacancyFunnelColumn, stages: Partial<Record<string, T[]>>): T[] {
  return col.sources.flatMap((s) => stages[s] ?? []);
}

export function columnCount(col: VacancyFunnelColumn, counts: Partial<Record<string, number>> | undefined): number {
  return col.sources.reduce((acc, s) => acc + (counts?.[s] ?? 0), 0);
}

/**
 * Etapa da Lista = coluna do Kanban em que o prestador está. O back decide `kanbanColumn`
 * (deriveKanbanColumn); aqui só se traduz source → id da coluna (IN_PROGRESS → PRE_SCREENING).
 * Nulo ou fora do mapa → null.
 */
export function stageColumnIdFor(kanbanColumn: string | null | undefined): VacancyFunnelColumnId | null {
  if (!kanbanColumn) return null;
  return VACANCY_FUNNEL_COLUMNS.find((c) => c.sources.includes(kanbanColumn))?.id ?? null;
}
