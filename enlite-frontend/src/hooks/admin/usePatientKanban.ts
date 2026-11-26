import { useState, useEffect, useCallback, useRef } from 'react';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { AdminContractedServicesApiService, ContractedServiceApiError } from '@infrastructure/http/AdminContractedServicesApiService';
import type { PatientKanbanItem, PatientKanbanServiceSummary } from '@domain/entities/PatientDetail';
import { ADMISSION_FUNNEL_STATUSES } from '@domain/entities/patientEnums';

/**
 * As colunas do board agrupam por `patients.status` (estado clínico v2). ADMISSION junta os 3
 * estados do funil de admissão antigo (SOLICITANTE, ADMISSION, PENDING_ADMISSION) numa coluna só;
 * os demais estados clínicos (SEARCHING, REPLACEMENT, ACTIVE, ON_HOLD, SUSPENDED, ALTA,
 * DISCHARGED) têm cada um a sua coluna.
 */
export const PATIENT_KANBAN_STATUSES = [
  'ADMISSION',
  'SEARCHING',
  'REPLACEMENT',
  'ACTIVE',
  'ON_HOLD',
  'SUSPENDED',
  'ALTA',
  'DISCHARGED',
] as const;

export type PatientKanbanStatus = (typeof PATIENT_KANBAN_STATUSES)[number];

export type PatientKanbanGroups = Record<PatientKanbanStatus, PatientKanbanItem[]>;

function emptyGroups(): PatientKanbanGroups {
  return {
    ADMISSION: [],
    SEARCHING: [],
    REPLACEMENT: [],
    ACTIVE: [],
    ON_HOLD: [],
    SUSPENDED: [],
    ALTA: [],
    DISCHARGED: [],
  };
}

function columnOf(status: string | null): PatientKanbanStatus | null {
  if (status && (ADMISSION_FUNNEL_STATUSES as readonly string[]).includes(status)) return 'ADMISSION';
  return (PATIENT_KANBAN_STATUSES as readonly string[]).includes(status ?? '')
    ? (status as PatientKanbanStatus)
    : null;
}

function groupByStatus(items: PatientKanbanItem[]): PatientKanbanGroups {
  const groups = emptyGroups();
  for (const item of items) {
    const col = columnOf(item.status);
    if (col) groups[col].push(item);
  }
  return groups;
}

/**
 * Data for the patient kanban (read-only since F5 of estado-automatico-do-paciente: the board does not move
 * cards — status is set by the automatic flow and by the patient-sheet actions).
 *
 * NOTE: grouping depends on each row carrying `status`. See listPatientsForKanban. Agrupa por
 * `patients.status`; admisión junta os 3 do funil.
 */
export function usePatientKanban(country?: string) {
  const [groups, setGroups] = useState<PatientKanbanGroups>(emptyGroups);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // DX-8.9: estado do agregado do subcard, carregado em paralelo com a listagem. `undefined` até
  // a 1ª carga assentar. 'forbidden' (403) é silencioso (o ator não lê serviços); 'error' mostra
  // o aviso da página (P13) — nunca silêncio nesse caso.
  const [servicesStatus, setServicesStatus] = useState<'ok' | 'forbidden' | 'error' | undefined>(undefined);
  const isFetchingRef = useRef(false);
  const fetchBoard = useCallback(async () => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    try {
      setIsLoading(true);
      setError(null);
      // DX-8.9: os dois EM PARALELO (Promise.allSettled) — o board só renderiza quando ambos
      // assentam, um estado de carga só (sem esqueleto por card). A listagem rejeitada cai no
      // `catch` de hoje; o agregado rejeitado nunca derruba a página (sem serviço no board).
      const [list, agg] = await Promise.allSettled([
        AdminApiService.listPatientsForKanban(country || undefined),
        AdminContractedServicesApiService.listKanbanServices(country || undefined),
      ]);
      if (list.status === 'rejected') throw list.reason;

      let status: 'ok' | 'forbidden' | 'error';
      const servicesByPatient = new Map<string, PatientKanbanServiceSummary[]>();
      if (agg.status === 'fulfilled') {
        status = 'ok';
        for (const p of agg.value.patients) servicesByPatient.set(p.patientId, p.services);
      } else {
        status = agg.reason instanceof ContractedServiceApiError && agg.reason.status === 403 ? 'forbidden' : 'error';
      }
      setServicesStatus(status);

      const items = list.value.map((item) => ({
        ...item,
        services: status === 'ok' ? (servicesByPatient.get(item.id) ?? []) : undefined,
      }));
      setGroups(groupByStatus(items));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load patients');
    } finally {
      setIsLoading(false);
      isFetchingRef.current = false;
    }
  }, [country]);

  useEffect(() => { fetchBoard(); }, [fetchBoard]);

  return { groups, isLoading, error, servicesStatus, refetch: fetchBoard };
}
