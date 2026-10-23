/**
 * ListSubstitutionRequestsUseCase — spec 069, FR-20/US6: a aba "Sustituciones". Lê o cabeçalho + ausências + registro de
 * trocas por serviço (`SubstitutionRequestReader`) e DESCREVE cada pedido por `describeRequest` (tipo, período, nº de turnos,
 * Entra pela fonte única, "salvo", "Ajustado", Próximas × Pasadas, `undoable`) — nada disso é coluna. Ausência sem pedido
 * (anterior à 548) entra como linha "Sin pedido (anterior)", sem motivo e sem "Deshacer" (P2). Nomes pela MESMA
 * `projectWorkerDisplayNames` (célula `worker_contact:read`), de quem sai e de quem entra.
 */
import type { PoolClient } from 'pg';
import { inPatientTransaction } from './patientTransaction';
import { operationDateOf } from './itineraryCoverage';
import { SubstitutionRequestReader, type ServiceRequestRows } from '../infrastructure/SubstitutionRequestReader';
import { describeLegacyAbsence, describeRequest, type RequestView } from '../domain/substitutionRequest';
import { projectWorkerDisplayNames, type WorkerNameSource } from './workerDisplayNames';
import { SubstitutionServiceNotFoundError } from './substitutionRequestErrors';
import { type Decryptor } from '@modules/identity/permissions';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';

export interface SubstitutionRequestsReaderPort {
  readForServiceWith(client: PoolClient, patientId: string, serviceId: string): Promise<ServiceRequestRows | null>;
}

type TransactionRunner = <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;

export type SubstitutionWhen = 'upcoming' | 'past';

export interface SubstitutionRequestListItem extends RequestView {
  outgoingDisplayName: string | null;
  /** Nome de quem entra, na ordem de `entra.workerIds`. */
  entraDisplayNames: Array<string | null>;
  /** Nome por turno (mesma ordem de `shifts`); `null` = "Nadie todavía" ou sem a célula. */
  shiftDisplayNames: Array<string | null>;
}

export interface ListSubstitutionRequestsResult {
  patientId: string;
  serviceId: string;
  when: SubstitutionWhen;
  requests: SubstitutionRequestListItem[];
}

export class ListSubstitutionRequestsUseCase {
  constructor(
    private readonly reader: SubstitutionRequestsReaderPort = new SubstitutionRequestReader(),
    private readonly kms: Decryptor = new KMSEncryptionService(),
    private readonly runInTransaction: TransactionRunner = inPatientTransaction,
  ) {}

  async execute(input: { patientId: string; serviceId: string; when: SubstitutionWhen; cells?: string[] | null; now?: Date }): Promise<ListSubstitutionRequestsResult> {
    const { patientId, serviceId, when, cells = null, now = new Date() } = input;
    const rows = await this.runInTransaction((client) => this.reader.readForServiceWith(client, patientId, serviceId));
    if (rows === null) throw new SubstitutionServiceNotFoundError(patientId, serviceId);

    const hoje = operationDateOf(rows.country, now);
    const views = this.describeAll(rows, hoje).filter((v) => v.when === when);
    // Próximas: a mais próxima primeiro; Pasadas: a mais recente primeiro.
    views.sort((a, b) => (when === 'upcoming' ? a.from.localeCompare(b.from) : b.from.localeCompare(a.from)));

    const sources = new Map<string, WorkerNameSource>(rows.workerNames.map((w) => [w.workerId, { firstNameEncrypted: w.firstNameEncrypted, lastNameEncrypted: w.lastNameEncrypted }]));
    const names = await projectWorkerDisplayNames(sources, cells, this.kms);
    const nameOf = (workerId: string | null): string | null => (workerId ? (names.get(workerId) ?? null) : null);

    return {
      patientId,
      serviceId,
      when,
      requests: views.map((v) => ({
        ...v,
        outgoingDisplayName: nameOf(v.outgoingWorkerId),
        entraDisplayNames: v.entra.workerIds.map(nameOf),
        shiftDisplayNames: v.shifts.map((s) => nameOf(s.workerId)),
      })),
    };
  }

  private describeAll(rows: ServiceRequestRows, hoje: string): RequestView[] {
    const views = rows.headers.map((header) =>
      describeRequest(
        header,
        rows.absences.filter((a) => a.requestId === header.id),
        rows.logRows.filter((l) => l.requestId === header.id),
        hoje,
        rows.newAssignments,
      ),
    );
    // Ausência anterior à 548 (sem pedido), ainda viva: uma linha própria.
    for (const absence of rows.absences) {
      if (absence.requestId === null && absence.cancelledAt === null) views.push(describeLegacyAbsence(absence, absence.titularWorkerId, hoje));
    }
    return views;
  }
}
