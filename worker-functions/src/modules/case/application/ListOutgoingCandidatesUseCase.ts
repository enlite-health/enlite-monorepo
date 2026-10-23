/**
 * ListOutgoingCandidatesUseCase — spec 069, US3 "¿Quién no va a venir?": as PESSOAS com alocação `ACTIVE` vigente ou futura
 * neste serviço, UMA linha por pessoa (não por faixa). Nome pela MESMA `projectWorkerDisplayNames` (célula
 * `worker_contact:read`); sem a célula o nome é `null` e a pessoa continua na lista (a escolha é por id).
 */
import type { PoolClient } from 'pg';
import { inPatientTransaction } from './patientTransaction';
import { operationDateOf } from './itineraryCoverage';
import { SubstitutionRequestReader, type OutgoingCandidateRows } from '../infrastructure/SubstitutionRequestReader';
import { projectWorkerDisplayNames, type WorkerNameSource } from './workerDisplayNames';
import { SubstitutionServiceNotFoundError } from './substitutionRequestErrors';
import { type Decryptor } from '@modules/identity/permissions';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';

export interface OutgoingCandidatesReaderPort {
  readOutgoingCandidatesWith(client: PoolClient, patientId: string, serviceId: string, todayFor: (country: string) => string): Promise<OutgoingCandidateRows | null>;
}

type TransactionRunner = <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;

export interface OutgoingCandidateView {
  workerId: string;
  displayName: string | null;
}

export class ListOutgoingCandidatesUseCase {
  constructor(
    private readonly reader: OutgoingCandidatesReaderPort = new SubstitutionRequestReader(),
    private readonly kms: Decryptor = new KMSEncryptionService(),
    private readonly runInTransaction: TransactionRunner = inPatientTransaction,
  ) {}

  async execute(input: { patientId: string; serviceId: string; cells?: string[] | null; now?: Date }): Promise<OutgoingCandidateView[]> {
    const { patientId, serviceId, cells = null, now = new Date() } = input;
    const rows = await this.runInTransaction((client) =>
      this.reader.readOutgoingCandidatesWith(client, patientId, serviceId, (country) => operationDateOf(country, now)),
    );
    if (rows === null) throw new SubstitutionServiceNotFoundError(patientId, serviceId);

    const sources = new Map<string, WorkerNameSource>(rows.workers.map((w) => [w.workerId, { firstNameEncrypted: w.firstNameEncrypted, lastNameEncrypted: w.lastNameEncrypted }]));
    const names = await projectWorkerDisplayNames(sources, cells, this.kms);
    return rows.workers
      .map((w) => ({ workerId: w.workerId, displayName: names.get(w.workerId) ?? null }))
      .sort((a, b) => (a.displayName ?? '￿').localeCompare(b.displayName ?? '￿') || a.workerId.localeCompare(b.workerId));
  }
}
