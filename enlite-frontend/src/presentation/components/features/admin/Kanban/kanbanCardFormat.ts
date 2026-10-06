import { formatInstant } from '@presentation/utils/dateTimeFormat';

/** Formatação de datas curtas da tarjeta do Kanban (extraída do KanbanCard — limite de 400 linhas). */

/** "28/08 14:35" em -03 (Buenos Aires), 24h — data curta, hora sem segundos. */
export function formatLastSent(iso: string): string {
  return formatInstant(iso, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) ?? iso;
}
