import { useDraggable } from '@dnd-kit/core';
import { useTranslation } from 'react-i18next';

interface DraggableCardProps {
  id: string;
  /** When true, drag is visually blocked and no drag events are fired */
  disabled?: boolean;
  children: React.ReactNode;
}

export function DraggableCard({ id, disabled = false, children }: DraggableCardProps) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id, disabled });

  if (disabled) {
    // Só o ARRASTO é bloqueado (nenhum listener/attribute do dnd-kit é
    // repassado abaixo). O conteúdo do card continua clicável — o link de
    // perfil e o botão de comentários precisam funcionar mesmo em cards sem
    // encuadre (ex.: BLOQUEADO), então NÃO usamos pointer-events-none aqui.
    return (
      <div
        ref={setNodeRef}
        data-testid={`kanban-draggable-${id}`}
        data-drag-disabled="true"
        className="cursor-not-allowed"
        title={t('admin.kanban.orphanDragTooltip')}
        aria-label={t('admin.kanban.orphanDragTooltip')}
      >
        <div className="opacity-70">
          {children}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={setNodeRef}
      data-testid={`kanban-draggable-${id}`}
      className={isDragging ? 'opacity-30' : ''}
      {...listeners}
      {...attributes}
    >
      {children}
    </div>
  );
}
