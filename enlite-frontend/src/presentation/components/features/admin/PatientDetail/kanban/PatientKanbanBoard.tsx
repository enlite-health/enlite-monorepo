import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DndContext, DragEndEvent, DragOverlay, DragStartEvent,
  PointerSensor, useSensor, useSensors, closestCenter,
} from '@dnd-kit/core';
import { KanbanColumn } from '@presentation/components/features/admin/Kanban/KanbanColumn';
import { DraggableCard } from '@presentation/components/features/admin/Kanban/DraggableCard';
import { PatientKanbanCard } from './PatientKanbanCard';
import {
  PATIENT_KANBAN_STATUSES,
  type PatientKanbanGroups,
  type PatientKanbanStatus,
} from '@hooks/admin/usePatientKanban';
import type { PatientKanbanItem } from '@domain/entities/PatientDetail';

interface Props {
  groups: PatientKanbanGroups;
  onMove: (patientId: string, targetStatus: PatientKanbanStatus) => Promise<string | null>;
}

const COLUMN_COLOR: Record<PatientKanbanStatus, string> = {
  SOLICITANTE: 'bg-slate-400',
  ADMISSION: 'bg-blue-400',
  PENDING_ADMISSION: 'bg-yellow-400',
  ACTIVE: 'bg-green-500',
};

/**
 * Patient lifecycle kanban. Reuses the funnel primitives (KanbanColumn +
 * DraggableCard + dnd-kit DndContext) with patient cards and status columns.
 * Dropping a card onto a column calls onMove(patientId, status).
 */
export function PatientKanbanBoard({ groups, onMove }: Props): JSX.Element {
  const { t } = useTranslation();
  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const findCard = (id: string): PatientKanbanItem | undefined => {
    for (const s of PATIENT_KANBAN_STATUSES) {
      const found = groups[s].find((c) => c.id === id);
      if (found) return found;
    }
    return undefined;
  };

  function handleDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id));
  }

  async function handleDragEnd(event: DragEndEvent) {
    const patientId = activeId;
    setActiveId(null);
    const { over } = event;
    if (!over || !patientId) return;
    const target = String(over.id) as PatientKanbanStatus;
    if (!(PATIENT_KANBAN_STATUSES as readonly string[]).includes(target)) return;
    // no-op if dropped on its current column
    const card = findCard(patientId);
    if (card?.status === target) return;
    await onMove(patientId, target);
  }

  const activeCard = activeId ? findCard(activeId) : undefined;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      autoScroll={{ threshold: { x: 0.2, y: 0 }, acceleration: 18 }}
    >
      <div data-testid="patient-kanban-board" className="flex gap-3 overflow-x-auto pb-4">
        {PATIENT_KANBAN_STATUSES.map((status) => {
          const items = groups[status] ?? [];
          return (
            <KanbanColumn
              key={status}
              id={status}
              title={t(`admin.patients.kanban.columns.${status}`)}
              count={items.length}
              color={COLUMN_COLOR[status]}
              droppable
              dragActive={activeId !== null}
            >
              {items.map((p) => (
                <DraggableCard key={p.id} id={p.id}>
                  <PatientKanbanCard patient={p} />
                </DraggableCard>
              ))}
            </KanbanColumn>
          );
        })}
      </div>

      <DragOverlay>
        {activeCard ? (
          <div className="opacity-80 rotate-2">
            <PatientKanbanCard patient={activeCard} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
