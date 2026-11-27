import type { PatientKanbanItem } from '@domain/entities/PatientDetail';

/**
 * Filtro por cor do Kanban de pacientes (semaforo-da-vaga F3, P1). Roda NO CLIENTE sobre `worstSemaphore` — a pior cor que o
 * servidor já calculou por paciente (o board carrega tudo do país, sem request nova). O front não olha os serviços nem escolhe cor.
 *
 * Seleção vazia = tudo (devolve o MESMO objeto). Com seleção, fica só quem tem `worstSemaphore` entre as cores escolhidas;
 * `null` (sem vaga viva) e `undefined` (agregado não carregou) nunca casam. Todas as colunas continuam presentes, mesmo vazias.
 */
export function filterGroupsByWorstSemaphore<G extends Record<string, PatientKanbanItem[]>>(groups: G, selected: readonly string[]): G {
  if (selected.length === 0) return groups;
  const keep = new Set(selected);
  return Object.fromEntries(
    Object.entries(groups).map(([column, items]) => [column, items.filter((i) => i.worstSemaphore != null && keep.has(i.worstSemaphore))]),
  ) as G;
}
