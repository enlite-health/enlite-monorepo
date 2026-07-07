import { useDroppable } from '@dnd-kit/core';
import { ChevronsLeft, ChevronsRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
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
  /** Coluna colapsada num trilho fino (estilo ClickUp). A largura anima ao alternar. */
  collapsed?: boolean;
  /** Alterna colapsar/expandir. Sem esta prop o botão de colapsar não aparece. */
  onToggleCollapse?: () => void;
  children: React.ReactNode;
}

export function KanbanColumn({
  id,
  title,
  count,
  color,
  droppable = true,
  alert = false,
  dragActive = false,
  collapsed = false,
  onToggleCollapse,
  children,
}: KanbanColumnProps) {
  const { t } = useTranslation();
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

  // A largura entre expandida e o trilho fino (52px) é o que anima — transition-all
  // + duration-300 dá o efeito fluido de colapsar/expandir (estilo ClickUp). Como a
  // coluna que colapsa tem a largura interpolada, as vizinhas (flex-1) dão reflow suave.
  const widthClass = collapsed
    ? 'min-w-[52px] max-w-[52px] flex-none'
    : 'min-w-[260px] max-w-[300px] flex-1';

  const countBadge = (
    <span
      data-testid={`kanban-column-${id}-count`}
      className={`inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 rounded-full text-[11px] font-semibold ${
        alert ? 'bg-red-100 text-red-700' : 'bg-slate-200 text-slate-600'
      }`}
    >
      {count}
    </span>
  );

  if (collapsed) {
    return (
      <button
        type="button"
        ref={setNodeRef}
        data-testid={`kanban-column-${id}`}
        data-collapsed="true"
        data-valid-drop-target={validDropTarget ? 'true' : undefined}
        onClick={onToggleCollapse}
        aria-label={t('admin.kanban.expandColumn')}
        title={title}
        className={`group flex flex-col items-center gap-2 py-2.5 rounded-xl border cursor-pointer hover:bg-slate-100 ${stateClass} ${widthClass} transition-all duration-300 ease-in-out`}
      >
        <ChevronsRight className="w-4 h-4 text-slate-400 group-hover:text-primary transition-colors" aria-hidden="true" />
        {countBadge}
        <div className="flex items-center gap-1.5 mt-1 [writing-mode:vertical-rl] rotate-180">
          <span className={`w-2.5 h-2.5 rounded-full ${color}`} />
          <Typography variant="body" weight="semibold" className={alert ? 'text-red-700 text-sm' : 'text-[#180149] text-sm'}>
            {title}
          </Typography>
        </div>
      </button>
    );
  }

  return (
    <div
      ref={setNodeRef}
      data-testid={`kanban-column-${id}`}
      data-valid-drop-target={validDropTarget ? 'true' : undefined}
      className={`flex flex-col rounded-xl border ${stateClass} ${widthClass} transition-all duration-300 ease-in-out`}
    >
      <div
        className={`flex items-center justify-between px-3 py-2.5 border-b ${
          alert ? 'border-red-200 bg-red-50' : 'border-slate-200'
        }`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${color}`} />
          <Typography variant="body" weight="semibold" className={`truncate ${alert ? 'text-red-700 text-sm' : 'text-[#180149] text-sm'}`}>
            {title}
          </Typography>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {countBadge}
          {onToggleCollapse && (
            <button
              type="button"
              data-testid={`kanban-column-${id}-collapse`}
              onClick={onToggleCollapse}
              aria-label={t('admin.kanban.collapseColumn')}
              className="text-slate-400 hover:text-primary transition-colors"
            >
              <ChevronsLeft className="w-4 h-4" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2 p-2 overflow-y-auto max-h-[calc(100vh-280px)]">
        {children}
      </div>
    </div>
  );
}
