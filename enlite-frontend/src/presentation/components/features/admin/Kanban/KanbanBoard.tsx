import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { DndContext, DragEndEvent, DragOverlay, DragStartEvent, PointerSensor, useSensor, useSensors, closestCenter } from '@dnd-kit/core';
import type { FunnelStages, MoveEncuadreError } from '@hooks/admin/useWJAFunnel';
import { KanbanColumn } from './KanbanColumn';
import { KanbanCard } from './KanbanCard';
import { DraggableCard } from './DraggableCard';
import { RejectionReasonSelect } from './RejectionReasonSelect';

interface KanbanBoardProps {
  stages: FunnelStages;
  onMove: (encuadreId: string, targetStage: string, rejectionReasonCategory?: string) => Promise<MoveEncuadreError | null>;
}

const COLUMN_CONFIG = [
  { id: 'INVITED', color: 'bg-blue-400', droppable: true },
  { id: 'INICIADO', color: 'bg-indigo-400', droppable: false },
  { id: 'PRE_SCREENING', color: 'bg-violet-400', droppable: false },
  { id: 'IN_PROGRESS', color: 'bg-violet-500', droppable: false },
  { id: 'COMPLETED', color: 'bg-violet-600', droppable: false },
  { id: 'CONFIRMED', color: 'bg-cyan-400', droppable: true },
  { id: 'SELECTED', color: 'bg-green-500', droppable: true },
  { id: 'REJECTED', color: 'bg-red-400', droppable: true },
] as const;

// Droppable columns map directly to application_funnel_stage values
const DROPPABLE_STAGES = new Set(['INVITED', 'CONFIRMED', 'SELECTED', 'REJECTED']);

export function KanbanBoard({ stages, onMove }: KanbanBoardProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [activeId, setActiveId] = useState<string | null>(null);
  /** Stores the encuadreId (not wja.id) of the card being dragged */
  const [activeDragEncuadreId, setActiveDragEncuadreId] = useState<string | null>(null);
  const [showRejectionSelect, setShowRejectionSelect] = useState<{ encuadreId: string } | null>(null);

  function handleWorkerClick(workerId: string) {
    navigate(`/admin/workers/${workerId}`);
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  // Find the active card and its stage across all stages
  const activeCardInfo = activeId
    ? (Object.entries(stages) as [string, FunnelStages[keyof FunnelStages]][]).reduce<{ card: FunnelStages[keyof FunnelStages][0]; stage: string } | null>((found, [stage, items]) => {
        if (found) return found;
        const card = items.find((e) => e.id === activeId);
        return card ? { card, stage } : null;
      }, null)
    : null;

  function handleDragStart(event: DragStartEvent) {
    const wjaId = String(event.active.id);
    setActiveId(wjaId);
    // Resolve encuadreId from the card data — may be null for orphans
    const encuadreId = (Object.values(stages) as FunnelStages[keyof FunnelStages][])
      .flat()
      .find((c) => c.id === wjaId)?.encuadreId ?? null;
    setActiveDragEncuadreId(encuadreId);
  }

  async function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { over } = event;
    if (!over) {
      setActiveDragEncuadreId(null);
      return;
    }

    // Orphan cards (encuadreId=null) are drag-disabled via DraggableCard, but
    // guard here as well so no stale state can trigger a request.
    if (!activeDragEncuadreId) {
      setActiveDragEncuadreId(null);
      return;
    }

    const encuadreId = activeDragEncuadreId;
    setActiveDragEncuadreId(null);

    const targetStage = String(over.id);
    if (!DROPPABLE_STAGES.has(targetStage)) return;

    // If moving to REJECTED, show rejection reason select
    if (targetStage === 'REJECTED') {
      setShowRejectionSelect({ encuadreId });
      return;
    }

    await onMove(encuadreId, targetStage);
  }

  async function handleRejectionSubmit(encuadreId: string, category: string) {
    setShowRejectionSelect(null);
    await onMove(encuadreId, 'REJECTED', category);
  }

  return (
    <>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        <div data-testid="kanban-board" className="flex gap-3 overflow-x-auto pb-4">
          {COLUMN_CONFIG.map((col) => {
            const items = stages[col.id as keyof FunnelStages] ?? [];
            return (
              <KanbanColumn key={col.id} id={col.id} title={t(`admin.kanban.columns.${col.id}`)} count={items.length} color={col.color} droppable={col.droppable}>
                {items.map((enc) => (
                  <DraggableCard key={enc.id} id={enc.id} disabled={!enc.encuadreId}>
                    <KanbanCard
                      id={enc.id}
                      workerId={enc.workerId}
                      workerName={enc.workerName}
                      workerPhone={enc.workerPhone}
                      occupation={enc.occupation}
                      workZone={enc.workZone}
                      matchScore={enc.matchScore}
                      talentumStatus={enc.talentumStatus}
                      rejectionReasonCategory={enc.rejectionReasonCategory}
                      interviewDate={enc.interviewDate}
                      interviewTime={enc.interviewTime}
                      stage={col.id}
                      interviewResponse={enc.interviewResponse}
                      meetLink={enc.meetLink}
                      acquisitionChannel={enc.acquisitionChannel}
                      internalStage={enc.internalStage ?? null}
                      isBlocked={enc.isBlocked}
                      blockedReason={enc.blockedReason}
                      missingFields={enc.missingFields}
                      attemptCount={enc.attemptCount}
                      onWorkerClick={handleWorkerClick}
                      onReject={enc.encuadreId ? () => setShowRejectionSelect({ encuadreId: enc.encuadreId! }) : undefined}
                    />
                  </DraggableCard>
                ))}
              </KanbanColumn>
            );
          })}
        </div>

        <DragOverlay>
          {activeCardInfo ? (
            <div className="opacity-80 rotate-2">
              <KanbanCard
                id={activeCardInfo.card.id}
                workerId={activeCardInfo.card.workerId}
                workerName={activeCardInfo.card.workerName}
                workerPhone={activeCardInfo.card.workerPhone}
                occupation={activeCardInfo.card.occupation}
                workZone={activeCardInfo.card.workZone}
                matchScore={activeCardInfo.card.matchScore}
                talentumStatus={activeCardInfo.card.talentumStatus}
                rejectionReasonCategory={activeCardInfo.card.rejectionReasonCategory}
                interviewDate={activeCardInfo.card.interviewDate}
                interviewTime={activeCardInfo.card.interviewTime}
                stage={activeCardInfo.stage}
                interviewResponse={activeCardInfo.card.interviewResponse}
                meetLink={activeCardInfo.card.meetLink}
                internalStage={activeCardInfo.card.internalStage ?? null}
                acquisitionChannel={activeCardInfo.card.acquisitionChannel}
                isBlocked={activeCardInfo.card.isBlocked}
                blockedReason={activeCardInfo.card.blockedReason}
                missingFields={activeCardInfo.card.missingFields}
                attemptCount={activeCardInfo.card.attemptCount}
              />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {showRejectionSelect && (
        <RejectionReasonSelect
          onSubmit={(category) => handleRejectionSubmit(showRejectionSelect.encuadreId, category)}
          onCancel={() => setShowRejectionSelect(null)}
        />
      )}
    </>
  );
}
