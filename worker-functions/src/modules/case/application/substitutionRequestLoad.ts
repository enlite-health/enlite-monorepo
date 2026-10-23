/**
 * substitutionRequestLoad — carrega UM pedido de substituição e o descreve pela fonte única (`describeRequest`), para o desfazer
 * e o "Elegir quién entra" (spec 069 T304/T305). A decisão de "dá para desfazer?" (`undoable`), o tipo e o "desde" saem DAQUI —
 * nunca recalculados no caso de uso (um dono por conceito).
 */
import type { PoolClient } from 'pg';
import { operationDateOf } from './itineraryCoverage';
import { describeRequest, type RequestHeaderRow, type RequestView } from '../domain/substitutionRequest';
import { addDaysToDateString } from '../domain/itineraryEvents';
import type { RequestScopedAbsence, RequestScopedLog, ServiceRequestRows } from '../infrastructure/SubstitutionRequestReader';
import { SubstitutionRequestAlreadyUndoneError, SubstitutionRequestNotFoundError } from './substitutionRequestErrors';

export interface SubstitutionRequestReaderPort {
  readForServiceWith(client: PoolClient, patientId: string, serviceId: string): Promise<ServiceRequestRows | null>;
}

export interface LoadedRequest {
  header: RequestHeaderRow;
  view: RequestView;
  hoje: string;
  absences: RequestScopedAbsence[];
  logRows: RequestScopedLog[];
}

/** 404 se o serviço ou o pedido não existem (RLS inclusa); 409 se o pedido já foi desfeito. */
export async function loadRequest(
  reader: SubstitutionRequestReaderPort,
  client: PoolClient,
  ids: { patientId: string; serviceId: string; requestId: string },
  now: Date,
): Promise<LoadedRequest> {
  const rows = await reader.readForServiceWith(client, ids.patientId, ids.serviceId);
  const header = rows?.headers.find((h) => h.id === ids.requestId);
  if (rows === null || header === undefined) throw new SubstitutionRequestNotFoundError(ids.requestId);
  if (header.undoneAt !== null) throw new SubstitutionRequestAlreadyUndoneError(ids.requestId);

  const hoje = operationDateOf(rows.country, now);
  const absences = rows.absences.filter((a) => a.requestId === ids.requestId);
  const logRows = rows.logRows.filter((l) => l.requestId === ids.requestId);
  const view = describeRequest(header, absences, logRows, hoje, rows.newAssignments);
  return { header, view, hoje, absences, logRows };
}

/** O 1º dia SEM o titular de uma saída permanente: `REMOVE.effective_date` é o último dia trabalhado (+1); `REPLACE.effective_date` já é D. */
export function exitSinceOf(row: Pick<RequestScopedLog, 'kind' | 'effectiveDate'>): string {
  return row.kind === 'REMOVE' ? addDaysToDateString(row.effectiveDate, 1) : row.effectiveDate;
}
