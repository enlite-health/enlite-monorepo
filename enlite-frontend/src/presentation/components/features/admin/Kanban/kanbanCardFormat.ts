/** Formatação de datas curtas da tarjeta do Kanban (extraída do KanbanCard — limite de 400 linhas). */

/** "28/08 14:35" no fuso de quem olha — data curta, hora sem segundos. */
export function formatLastSent(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
