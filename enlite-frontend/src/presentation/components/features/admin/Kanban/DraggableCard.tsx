import { useDraggable } from '@dnd-kit/core';

interface DraggableCardProps {
  id: string;
  children: React.ReactNode;
}

export function DraggableCard({ id, children }: DraggableCardProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id });

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
