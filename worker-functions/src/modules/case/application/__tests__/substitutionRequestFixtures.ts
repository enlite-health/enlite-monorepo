/**
 * Fixtures dos testes do desfazer / "Elegir quién entra" (spec 069 F3): linhas cruas do `SubstitutionRequestReader` já no formato que
 * o caso de uso recebe. hoje (AR) = 2026-10-30.
 */
import type { RequestScopedAbsence, RequestScopedLog, ServiceRequestRows } from '../../infrastructure/SubstitutionRequestReader';

export const NOW = new Date('2026-10-30T15:00:00Z');
export const CLIENT = { marker: 'client' } as never;
export const RID = 'req-1';

export function header(over: Partial<ServiceRequestRows['headers'][number]> = {}): ServiceRequestRows['headers'][number] {
  return { id: RID, outgoingWorkerId: 'w-out', reasonCode: 'OTHER', createdAt: '2026-10-20T10:00:00.000Z', createdBy: 'u-0', undoneAt: null, undoneBy: null, ...over };
}

export function absence(id: string, onDate: string, over: Partial<RequestScopedAbsence> = {}): RequestScopedAbsence {
  return {
    absenceId: id, assignmentId: 'a-seg', requestId: RID, onDate, startTime: '08:00', endTime: '12:00', substituteWorkerId: null, cancelledAt: null,
    assignmentStatus: 'ACTIVE', assignmentValidTo: null, titularWorkerId: 'w-out', ...over,
  };
}

export function log(kind: RequestScopedLog['kind'], assignmentId: string, effectiveDate: string, over: Partial<RequestScopedLog> = {}): RequestScopedLog {
  return { requestId: RID, kind, assignmentId, newAssignmentId: null, effectiveDate, destination: 'RESERVE', ...over };
}

export function serviceRows(over: Partial<ServiceRequestRows> = {}): ServiceRequestRows {
  return { country: 'AR', headers: [header()], absences: [], logRows: [], newAssignments: [], workerNames: [], ...over };
}
