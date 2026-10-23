/**
 * GetPatientItineraryEventsUseCase — D445.3/D445.4 → spec 069: a agenda "Próximos días" da aba
 * Itinerario. Leitura calculada (`PatientItineraryEventsReader` + `expandServiceOccurrences`, puro, parte das FAIXAS) —
 * SEM materializar ocorrências, SEM tabela nova. Faixa sem alocação vigente sai como `uncovered` com ids nulos (FR-12). `asOf`/intervalo por data de operação do PAÍS
 * (`operationDateOf`, a mesma fonte de `GetPatientItineraryUseCase`), nunca o relógio UTC do
 * processo. Nome do prestador (titular e substituto) pela MESMA `projectWorkerDisplayNames`
 * (célula `worker_contact:read`, `req.permissionCells`) — nenhuma 2ª decodificação.
 */
import {
  PatientItineraryEventsReader,
  type ItineraryEventsRows,
} from '../infrastructure/PatientItineraryEventsReader';
import { expandServiceOccurrences, type ServiceOccurrence } from '../domain/serviceOccurrences';
import { projectWorkerDisplayNames, type WorkerNameSource } from './workerDisplayNames';
import { type Decryptor } from '@modules/identity/permissions';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';

/** Paciente inexistente/soft-deletado/outro país — o controller mapeia para 404. */
export class PatientNotFoundForItineraryEventsError extends Error {
  constructor(readonly patientId: string) {
    super(`Patient not found: ${patientId}`);
    this.name = 'PatientNotFoundForItineraryEventsError';
  }
}

/** `to < from`, ou intervalo maior que o teto — o controller mapeia para 400. */
export class ItineraryEventsRangeInvalidError extends Error {
  constructor(
    readonly from: string,
    readonly to: string,
    readonly maxDays: number,
  ) {
    super(`Invalid itinerary events range: ${from}..${to} (max ${maxDays} days)`);
    this.name = 'ItineraryEventsRangeInvalidError';
  }
}

/** `assignmentId`, `titularWorkerId` e `absenceId` são `null` na faixa sem alocação vigente; `requestId` liga o turno ao pedido. */
export interface PatientItineraryEventView extends ServiceOccurrence {
  workerDisplayName: string | null;
  titularDisplayName: string | null;
  substituteDisplayName: string | null;
}

export interface PatientItineraryEventsResult {
  patientId: string;
  from: string;
  to: string;
  events: PatientItineraryEventView[];
}

export interface PatientItineraryEventsInput {
  patientId: string;
  from: string;
  to: string;
  serviceId?: string;
  workerId?: string;
  now?: Date;
  cells?: string[] | null;
}

/** D445.3: "intervalo máximo limitado (ex. 62 dias → 400 acima disso)". */
export const ITINERARY_EVENTS_MAX_DAYS = 62;

export interface PatientItineraryEventsReaderPort {
  readForRange(patientId: string, from: string, to: string): Promise<ItineraryEventsRows | null>;
}

export class GetPatientItineraryEventsUseCase {
  constructor(
    private readonly reader: PatientItineraryEventsReaderPort = new PatientItineraryEventsReader(),
    private readonly kms: Decryptor = new KMSEncryptionService(),
  ) {}

  async execute(input: PatientItineraryEventsInput): Promise<PatientItineraryEventsResult> {
    const { patientId, from, to, serviceId, workerId, cells = null } = input;

    if (to < from) throw new ItineraryEventsRangeInvalidError(from, to, ITINERARY_EVENTS_MAX_DAYS);
    const dayCount = dayCountInclusiveSafe(from, to);
    if (dayCount === null || dayCount > ITINERARY_EVENTS_MAX_DAYS) {
      throw new ItineraryEventsRangeInvalidError(from, to, ITINERARY_EVENTS_MAX_DAYS);
    }

    const rows = await this.reader.readForRange(patientId, from, to);
    if (rows === null) throw new PatientNotFoundForItineraryEventsError(patientId);

    const events = expandServiceOccurrences(rows.slots, rows.assignments, rows.absences, from, to, { serviceId, workerId });

    const nameSourceByWorkerId = new Map<string, WorkerNameSource>(
      rows.workerNames.map((w) => [w.workerId, { firstNameEncrypted: w.firstNameEncrypted, lastNameEncrypted: w.lastNameEncrypted }]),
    );
    const displayNameByWorkerId = await projectWorkerDisplayNames(nameSourceByWorkerId, cells, this.kms);

    const views: PatientItineraryEventView[] = events.map((event) => ({
      ...event,
      workerDisplayName: event.workerId ? (displayNameByWorkerId.get(event.workerId) ?? null) : null,
      titularDisplayName: event.titularWorkerId ? (displayNameByWorkerId.get(event.titularWorkerId) ?? null) : null,
      substituteDisplayName: event.substituteWorkerId ? (displayNameByWorkerId.get(event.substituteWorkerId) ?? null) : null,
    }));

    return { patientId, from, to, events: views };
  }
}

/** `dayCountInclusive` do domínio, mas tolerante a lixo de data (o zod da rota já valida forma; aqui é defesa em profundidade). */
function dayCountInclusiveSafe(from: string, to: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return null;
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const fromMs = Date.UTC(fy, fm - 1, fd);
  const toMs = Date.UTC(ty, tm - 1, td);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return null;
  return Math.round((toMs - fromMs) / 86_400_000) + 1;
}
