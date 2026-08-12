import { useState, useEffect, useCallback, useRef } from 'react';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import type { PatientKanbanItem } from '@domain/entities/PatientDetail';

/** The four main lifecycle columns shown on the board (terminals excluded). */
export const PATIENT_KANBAN_STATUSES = [
  'SOLICITANTE',
  'ADMISSION',
  'PENDING_ADMISSION',
  'ACTIVE',
] as const;

export type PatientKanbanStatus = (typeof PATIENT_KANBAN_STATUSES)[number];

export type PatientKanbanGroups = Record<PatientKanbanStatus, PatientKanbanItem[]>;

function emptyGroups(): PatientKanbanGroups {
  return { SOLICITANTE: [], ADMISSION: [], PENDING_ADMISSION: [], ACTIVE: [] };
}

function groupByStatus(items: PatientKanbanItem[]): PatientKanbanGroups {
  const groups = emptyGroups();
  for (const item of items) {
    const s = item.status as PatientKanbanStatus | null;
    if (s && s in groups) groups[s].push(item);
  }
  return groups;
}

/**
 * Data + move logic for the patient kanban. Mirrors useWJAFunnel's shape (fetch
 * + move + refetch), but moves change patient lifecycle status via
 * PUT /api/admin/patients/:id/status. The move is optimistic with rollback on
 * error (the funnel refetches; here we keep it snappy for drag-and-drop).
 *
 * NOTE: grouping depends on each row carrying `status`. See listPatientsForKanban.
 */
export function usePatientKanban(country?: string) {
  const [groups, setGroups] = useState<PatientKanbanGroups>(emptyGroups);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isFetchingRef = useRef(false);

  const fetchBoard = useCallback(async () => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    try {
      setIsLoading(true);
      setError(null);
      const items = await AdminApiService.listPatientsForKanban(country || undefined);
      setGroups(groupByStatus(items));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load patients');
    } finally {
      setIsLoading(false);
      isFetchingRef.current = false;
    }
  }, [country]);

  useEffect(() => { fetchBoard(); }, [fetchBoard]);

  /**
   * Move a patient card to another status column. Optimistic: the card moves
   * immediately; on failure the previous grouping is restored and the error is
   * returned to the caller (so it can toast).
   */
  const moveStatus = useCallback(async (
    patientId: string,
    targetStatus: PatientKanbanStatus,
  ): Promise<string | null> => {
    let previous: PatientKanbanGroups | null = null;
    setGroups((prev) => {
      previous = prev;
      // find the card in any column
      let card: PatientKanbanItem | undefined;
      for (const key of PATIENT_KANBAN_STATUSES) {
        const found = prev[key].find((c) => c.id === patientId);
        if (found) { card = found; break; }
      }
      if (!card) return prev;
      const next = emptyGroups();
      for (const key of PATIENT_KANBAN_STATUSES) {
        next[key] = prev[key].filter((c) => c.id !== patientId);
      }
      next[targetStatus] = [{ ...card, status: targetStatus }, ...next[targetStatus]];
      return next;
    });

    try {
      await AdminApiService.updatePatientStatus(patientId, targetStatus);
      return null;
    } catch (err) {
      if (previous) setGroups(previous);
      return err instanceof Error ? err.message : 'Failed to move patient';
    }
  }, []);

  return { groups, isLoading, error, refetch: fetchBoard, moveStatus };
}
