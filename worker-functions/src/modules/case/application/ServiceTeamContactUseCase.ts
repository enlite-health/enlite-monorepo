/**
 * ServiceTeamContactUseCase — quadro C (Servicio Contratado), modal do prestador (Figma, rodada
 * 2, decisão D do brief). Dois casos de uso, um arquivo (molde `GetServiceTeamUseCase` +
 * `ServiceTeamMarkUseCase`, que também compartilham módulo/leitor):
 *
 *   `GetServiceTeamContactUseCase`  — nome/telefone do prestador (projetados) + histórico.
 *   `RegisterServiceTeamContactUseCase` — grava um registro de contato (linha NOVA, nunca update)
 *                                          e devolve o mesmo formato, recalculado.
 *
 * Autorização (antes de qualquer leitura/escrita do log): o `workerId` tem de estar em
 * `selected`/`inService`/`rejected` do time ATUAL do serviço — reusa `ServiceTeamReader` +
 * `deriveServiceTeamFromRows`, a MESMA fonte do GET .../team. Serviço inexistente, de outro
 * paciente, fora da RLS, OU prestador que nunca fez parte deste time → `ServiceTeamContactNotFoundError`
 * (404) — não distingue os três (não vaza existência, mesmo molde do `ServiceTeamNotFoundError`).
 *
 * Telefone: a célula decide ANTES do KMS (C3) — `projectWorkerFields` com
 * `whatsappPhoneEncrypted` faz a mesma projeção que já protege o nome no quadro C
 * (`worker_contact:read`); sem a célula, `phone`/`whatsappPhone` saem `null` (nunca erro).
 *
 * `note` (Notas) NUNCA entra em `reportError`/log — nem aqui, nem no controller: os únicos dados
 * logados por este módulo são ids e o resultado da operação.
 */
import type { PoolClient } from 'pg';
import { inPatientTransaction } from './patientTransaction';
import { ServiceTeamReader, type ServiceTeamRows } from '../infrastructure/ServiceTeamReader';
import { deriveServiceTeamFromRows } from './serviceTeamPresentation';
import {
  ServiceTeamContactLogRepository,
  type ServiceTeamContactLogRow,
  type WorkerContactRow,
  type InsertContactLogInput,
} from '../infrastructure/ServiceTeamContactLogRepository';
import { projectWorkerFields, type Decryptor } from '@modules/identity/permissions';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';

export interface ServiceTeamContactReaderPort {
  readWith(client: PoolClient, patientId: string, serviceId: string): Promise<ServiceTeamRows | null>;
}

export interface ServiceTeamContactRepoPort {
  listForPair(client: PoolClient, serviceId: string, workerId: string): Promise<ServiceTeamContactLogRow[]>;
  insert(client: PoolClient, input: InsertContactLogInput): Promise<void>;
  getWorkerContactRow(client: PoolClient, workerId: string): Promise<WorkerContactRow | null>;
}

type TransactionRunner = <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;

/** Serviço inexistente/de outro paciente/fora da RLS, OU worker que não é (nem foi) deste time. */
export class ServiceTeamContactNotFoundError extends Error {
  constructor(
    readonly patientId: string,
    readonly serviceId: string,
    readonly workerId: string,
  ) {
    super(`Service team contact not found: worker=${workerId} service=${serviceId} patient=${patientId}`);
    this.name = 'ServiceTeamContactNotFoundError';
  }
}

export interface ServiceTeamContactHistoryEntry {
  id: string;
  contacted: boolean;
  eventDate: string;
  note: string | null;
  createdAt: string;
}

export interface ServiceTeamContactResult {
  workerId: string;
  displayName: string | null;
  /** `null` sem `worker_contact:read` (C3) — nunca erro. */
  phone: string | null;
  history: ServiceTeamContactHistoryEntry[];
}

export interface ServiceTeamContactBaseInput {
  patientId: string;
  serviceId: string;
  workerId: string;
  /** `null` = engine de permissão não decidiu nesta request (D113). */
  cells: string[] | null;
  now?: Date;
}

export interface RegisterServiceTeamContactInput extends ServiceTeamContactBaseInput {
  contacted: boolean;
  eventDate: string;
  note: string | null;
  actorUid: string;
}

/** `workerId` está em alguma das 3 listas do time ATUAL — a mesma checagem que `ServiceTeamMarkUseCase` faz antes de rejeitar/reverter. */
function isMemberOfTeam(
  team: { selected: { workerId: string }[]; inService: { workerId: string }[]; rejected: { workerId: string }[] },
  workerId: string,
): boolean {
  return (
    team.selected.some((m) => m.workerId === workerId) ||
    team.inService.some((m) => m.workerId === workerId) ||
    team.rejected.some((m) => m.workerId === workerId)
  );
}

async function loadAuthorizedRow(
  client: PoolClient,
  reader: ServiceTeamContactReaderPort,
  patientId: string,
  serviceId: string,
  workerId: string,
  now: Date,
): Promise<ServiceTeamRows> {
  const row = await reader.readWith(client, patientId, serviceId);
  if (row === null) throw new ServiceTeamContactNotFoundError(patientId, serviceId, workerId);
  const team = deriveServiceTeamFromRows(row, now);
  if (!isMemberOfTeam(team, workerId)) {
    throw new ServiceTeamContactNotFoundError(patientId, serviceId, workerId);
  }
  return row;
}

async function projectContact(
  contactRepo: ServiceTeamContactRepoPort,
  client: PoolClient,
  workerId: string,
  cells: string[] | null,
  kms: Decryptor,
): Promise<{ displayName: string | null; phone: string | null }> {
  const workerRow = await contactRepo.getWorkerContactRow(client, workerId);
  const projected = await projectWorkerFields(
    cells,
    {
      id: workerId,
      firstNameEncrypted: workerRow?.firstNameEncrypted ?? null,
      lastNameEncrypted: workerRow?.lastNameEncrypted ?? null,
      whatsappPhoneEncrypted: workerRow?.whatsappPhoneEncrypted ?? null,
    },
    kms,
  );
  return { displayName: projected.name ?? null, phone: projected.whatsappPhone ?? null };
}

function toEntry(row: ServiceTeamContactLogRow): ServiceTeamContactHistoryEntry {
  return { id: row.id, contacted: row.contacted, eventDate: row.eventDate, note: row.note, createdAt: row.createdAt };
}

export class GetServiceTeamContactUseCase {
  constructor(
    private readonly reader: ServiceTeamContactReaderPort = new ServiceTeamReader(),
    private readonly contactRepo: ServiceTeamContactRepoPort = new ServiceTeamContactLogRepository(),
    private readonly kms: Decryptor = new KMSEncryptionService(),
    private readonly runInTransaction: TransactionRunner = inPatientTransaction,
  ) {}

  async execute(input: ServiceTeamContactBaseInput): Promise<ServiceTeamContactResult> {
    const { patientId, serviceId, workerId, cells, now = new Date() } = input;

    return this.runInTransaction(async (client) => {
      await loadAuthorizedRow(client, this.reader, patientId, serviceId, workerId, now);
      const [{ displayName, phone }, historyRows] = await Promise.all([
        projectContact(this.contactRepo, client, workerId, cells, this.kms),
        this.contactRepo.listForPair(client, serviceId, workerId),
      ]);
      return { workerId, displayName, phone, history: historyRows.map(toEntry) };
    });
  }
}

export class RegisterServiceTeamContactUseCase {
  constructor(
    private readonly reader: ServiceTeamContactReaderPort = new ServiceTeamReader(),
    private readonly contactRepo: ServiceTeamContactRepoPort = new ServiceTeamContactLogRepository(),
    private readonly kms: Decryptor = new KMSEncryptionService(),
    private readonly runInTransaction: TransactionRunner = inPatientTransaction,
  ) {}

  async execute(input: RegisterServiceTeamContactInput): Promise<ServiceTeamContactResult> {
    const { patientId, serviceId, workerId, cells, contacted, eventDate, note, actorUid, now = new Date() } = input;

    return this.runInTransaction(async (client) => {
      await loadAuthorizedRow(client, this.reader, patientId, serviceId, workerId, now);
      await this.contactRepo.insert(client, { serviceId, workerId, contacted, eventDate, note, actorUid });
      const [{ displayName, phone }, historyRows] = await Promise.all([
        projectContact(this.contactRepo, client, workerId, cells, this.kms),
        this.contactRepo.listForPair(client, serviceId, workerId),
      ]);
      return { workerId, displayName, phone, history: historyRows.map(toEntry) };
    });
  }
}
