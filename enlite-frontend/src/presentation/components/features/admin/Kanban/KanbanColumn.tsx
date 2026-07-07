import { useDroppable } from '@dnd-kit/core';
import { Typography } from '@presentation/components/atoms/Typography';

interface KanbanColumnProps {
  id: string;
  title: string;
  count: number;
  color: string;
  droppable?: boolean;
  /** Alert-styled header (red tone) for columns that need operator attention, e.g. BLOQUEADO */
  alert?: boolean;
  /** True enquanto um card está sendo arrastado — realça as colunas que aceitam drop
   *  (verde) e esmaece as que não aceitam, pra guiar o operador até o alvo certo. */
  dragActive?: boolean;
  children: React.ReactNode;
}

export function KanbanColumn({ id, title, count, color, droppable = true, alert = false, dragActive = false, children }: KanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id, disabled: !droppable });

  const validDropTarget = dragActive && droppable;

  // Prioridade: hover ativo (roxo forte) > destino válido durante drag (verde) >
  // destino inválido durante drag (esmaecido) > alert > default.
  const stateClass = isOver
    ? 'border-purple-400 bg-purple-50/50 ring-2 ring-purple-300'
    : validDropTarget
      ? 'border-green-400 bg-green-50/50 ring-2 ring-green-200'
      : dragActive && !droppable
        ? 'border-slate-200 bg-slate-50/50 opacity-50'
        : alert
          ? 'border-red-200 bg-red-50/40'
          : 'border-slate-200 bg-slate-50/50';

  return (
    <div
      ref={setNodeRef}
      data-testid={`kanban-column-${id}`}
      data-valid-drop-target={validDropTarget ? 'true' : undefined}
      className={`flex flex-col min-w-[260px] max-w-[300px] flex-1 rounded-xl border ${stateClass} transition-colors`}
    >
      <div
        className={`flex items-center justify-between px-3 py-2.5 border-b ${
          alert ? 'border-red-200 bg-red-50' : 'border-slate-200'
        }`}
      >
        <div className="flex items-center gap-2">
          <div className={`w-2.5 h-2.5 rounded-full ${color}`} />
          <Typography variant="body" weight="semibold" className={alert ? 'text-red-700 text-sm' : 'text-[#180149] text-sm'}>
            {title}
          </Typography>
        </div>
        <span
          data-testid={`kanban-column-${id}-count`}
          className={`inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 rounded-full text-[11px] font-semibold ${
            alert ? 'bg-red-100 text-red-700' : 'bg-slate-200 text-slate-600'
          }`}
        >
          {count}
        </span>
      </div>

      <div className="flex flex-col gap-2 p-2 overflow-y-auto max-h-[calc(100vh-280px)]">
        {children}
      </div>
    </div>
  );
}
