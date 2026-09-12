import { useState, useEffect, useCallback, useRef } from 'react';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import type { PatientKanbanItem } from '@domain/entities/PatientDetail';

/**
 * As colunas do board = o FUNIL DE ADMISSÃO (`patients.admission_status`, migration 313 — spec
 * 012, US-B7). DONE é a coluna "Activo": quem já passou pela admissão, qualquer que seja o estado
 * clínico v2 (ACTIVE, ON_HOLD, SEARCHING…). O estado clínico mora na ficha, não aqui.
 */
export const PATIENT_KANBAN_STATUSES = [
  'SOLICITANTE',
  'ADMISSION',
  'PENDING_ADMISSION',
  'DONE',
] as const;

export type PatientKanbanStatus = (typeof PATIENT_KANBAN_STATUSES)[number];

export type PatientKanbanGroups = Record<PatientKanbanStatus, PatientKanbanItem[]>;

/**
 * Falha ao mover um card. `code` é o código de enum do backend (nunca o texto cru do servidor);
 * `missing` só vem no 422 de completude (decisão do Gabriel 07/09) e carrega os códigos do
 * checklist, para o toast poder NOMEAR o que falta em vez de dizer só "não foi possível".
 */
export interface PatientKanbanMoveError {
  code: string;
  missing?: string[];
}

function emptyGroups(): PatientKanbanGroups {
  return { SOLICITANTE: [], ADMISSION: [], PENDING_ADMISSION: [], DONE: [] };
}

function groupByAdmissionStatus(items: PatientKanbanItem[]): PatientKanbanGroups {
  const groups = emptyGroups();
  for (const item of items) {
    const s = item.admissionStatus as PatientKanbanStatus;
    if (s in groups) groups[s].push(item);
  }
  return groups;
}

/**
 * Código devolvido quando o alvo é DONE ("Activo") — spec 018, PR-6, ADR-5. Até 07/09 soltar
 * ali mandava `PUT /status {status:'ACTIVE'}` (a transição que a 315 seedava a partir de
 * qualquer coluna do funil); a migration 428 REMOVE essa linha do catálogo — o Kanban não pode
 * continuar chamando uma transição que o backend vai recusar (422
 * `PATIENT_STATUS_TRANSITION_NOT_ALLOWED`). Ativar virou uma ação por SERVIÇO
 * (`ServicosContratadosCard`, "Activar reclutamiento"), não um drop de card.
 */
export const KANBAN_ACTIVATION_MOVED_TO_SERVICE = 'KANBAN_ACTIVATION_MOVED_TO_SERVICE';

/**
 * Data + move logic for the patient kanban. Mirrors useWJAFunnel's shape (fetch
 * + move + refetch), but moves change patient lifecycle status via
 * PUT /api/admin/patients/:id/status. The move is optimistic with rollback on
 * error (the funnel refetches; here we keep it snappy for drag-and-drop).
 *
 * NOTE: grouping depends on each row carrying `admissionStatus`. See listPatientsForKanban.
 */
export function usePatientKanban(country?: string) {
  const [groups, setGroupsState] = useState<PatientKanbanGroups>(emptyGroups);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isFetchingRef = useRef(false);
  // O agrupamento CORRENTE, síncrono: o rollback do movimento otimista precisa do estado
  // anterior no instante do clique — o updater do setState roda depois, batched, e um PUT que
  // rejeita no mesmo tick chegava antes dele (medido: o card sumia em vez de voltar).
  const groupsRef = useRef<PatientKanbanGroups>(groups);
  const setGroups = useCallback((next: PatientKanbanGroups) => { groupsRef.current = next; setGroupsState(next); }, []);

  const fetchBoard = useCallback(async () => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    try {
      setIsLoading(true);
      setError(null);
      const items = await AdminApiService.listPatientsForKanban(country || undefined);
      setGroups(groupByAdmissionStatus(items));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load patients');
    } finally {
      setIsLoading(false);
      isFetchingRef.current = false;
    }
  }, [country, setGroups]);

  useEffect(() => { fetchBoard(); }, [fetchBoard]);

  /**
   * Move a patient card to another column. Optimistic: the card moves
   * immediately; on failure the previous grouping is restored and the error is
   * returned to the caller (so it can toast).
   */
  const moveStatus = useCallback(async (
    patientId: string,
    targetStatus: PatientKanbanStatus,
  ): Promise<PatientKanbanMoveError | null> => {
    // Spec 018, PR-6, ADR-5: DONE ("Activo") não é mais um alvo de drop — a 428 tirou
    // funil→ACTIVE do catálogo. O card NÃO se move (sem otimismo para desfazer) e o chamador
    // toasta o caminho novo. Mover DENTRO do funil (SOLICITANTE/ADMISSION/PENDING_ADMISSION)
    // continua livre, exatamente como antes.
    if (targetStatus === 'DONE') {
      return { code: KANBAN_ACTIVATION_MOVED_TO_SERVICE };
    }

    const previous = groupsRef.current;
    // find the card in any column
    let card: PatientKanbanItem | undefined;
    for (const key of PATIENT_KANBAN_STATUSES) {
      const found = previous[key].find((c) => c.id === patientId);
      if (found) { card = found; break; }
    }
    if (card) {
      const next = emptyGroups();
      for (const key of PATIENT_KANBAN_STATUSES) {
        next[key] = previous[key].filter((c) => c.id !== patientId);
      }
      next[targetStatus] = [{ ...card, admissionStatus: targetStatus }, ...next[targetStatus]];
      setGroups(next);
    }

    try {
      await AdminApiService.updatePatientStatus(patientId, { status: targetStatus, changeSource: 'kanban' });
      return null;
    } catch (err) {
      setGroups(previous);
      // Spec 014 (US-D5, lex D5.1): devolve o CÓDIGO de enum quando o backend manda um
      // (`PatientApiError.code` — PATIENT_STATUS_TRANSITION_NOT_ALLOWED/ON_HOLD_REASON_REQUIRED),
      // nunca o texto cru — a página traduz o código, nunca ecoa `err.message` no toast. Erro
      // sem código (rede, 500 genérico) cai na mensagem, que é o único dado que existe ali.
      if (err instanceof Error) {
        const code = (err as { code?: string }).code;
        // Decisão do Gabriel 07/09: o 422 de completude vem com `details.missing` — os MESMOS
        // códigos do checklist. Levá-los adiante deixa o toast dizer O QUE falta em vez de só
        // "não foi possível mover"; a tradução continua sendo por código, nunca eco do servidor.
        const missing = (err as { details?: { missing?: unknown } }).details?.missing;
        return {
          code: code ?? err.message,
          missing: Array.isArray(missing) ? (missing as string[]) : undefined,
        };
      }
      return { code: 'Failed to move patient' };
    }
  }, [setGroups]);

  return { groups, isLoading, error, refetch: fetchBoard, moveStatus };
}
