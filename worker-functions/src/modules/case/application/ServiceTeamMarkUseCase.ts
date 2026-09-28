/**
 * ServiceTeamMarkUseCase — quadro C (Servicio Contratado), Fase 10, DX-10.6 (2).
 *
 * `reject` e `revert`: a ordem é a régua da sabotagem — motivo ausente/fora da lista fechada do
 * `kind` SEMPRE antes do banco (`ServiceTeamReasonRequiredError`/`ServiceTeamReasonInvalidError`,
 * `serviceTeamReason.ts`); só depois abre `inPatientTransaction`. Dentro da transação: lê o time
 * pelo MESMO leitor do GET, no MESMO client (`ServiceTeamReader.readWith`); serviço inexistente/
 * de outro paciente → `ServiceTeamNotFoundError` (mesma classe do GET — 404); rejeitar quem está
 * `inService` → `ServiceTeamWorkerAllocatedError` (invariante 10, "remova do itinerário
 * primeiro"); rejeitar quem não é candidato (`selected`) → `ServiceTeamNotSelectedError`
 * (invariante 1 — não há como pôr em C quem a vaga não pôs); reverter quem não está `rejected` →
 * `ServiceTeamNotRejectedError`. A corrida do índice `uq_csr_active_pair` (23505) vira
 * `ServiceTeamAlreadyRejectedError`.
 *
 * A escrita mora só em `ServiceTeamMarkWriter` (`insertRejection`/`revertRejection`): nunca
 * `worker_job_applications`, `encuadres` ou `patient_itinerary_*` (invariante 6). Devolve o time
 * RECALCULADO (mesma forma do `GetServiceTeamUseCase`) — o leitor é chamado de novo, no mesmo
 * client, depois da escrita: o front não precisa de um 2º GET.
 */
import type { PoolClient } from 'pg';
import { inPatientTransaction } from './patientTransaction';
import { operationDateOf } from './itineraryCoverage';
import { deriveServiceTeam } from '../domain/deriveServiceTeam';
import {
  isAllowedServiceTeamReason,
  ServiceTeamReasonRequiredError,
  ServiceTeamReasonInvalidError,
  type ServiceTeamReasonKind,
} from '../domain/serviceTeamReason';
import { ServiceTeamReader, type ServiceTeamRows } from '../infrastructure/ServiceTeamReader';
import { ServiceTeamMarkWriter } from '../infrastructure/ServiceTeamMarkWriter';
import { ServiceTeamNotFoundError, type GetServiceTeamResult } from './GetServiceTeamUseCase';
import { projectServiceTeamDisplayNames, buildServiceTeamResult } from './serviceTeamPresentation';
import { type Decryptor } from '@modules/identity/permissions';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';

/** Rejeitar prestador Em Atendimento (invariante 10) — o controller mapeia para 422 `SERVICE_TEAM_WORKER_ALLOCATED`. */
export class ServiceTeamWorkerAllocatedError extends Error {
  constructor(
    readonly patientId: string,
    readonly serviceId: string,
    readonly workerId: string,
  ) {
    super('remova do itinerário primeiro');
    this.name = 'ServiceTeamWorkerAllocatedError';
  }
}

/** Rejeitar quem não é candidato da vaga viva (invariante 1) — a vaga não pôs, C não pode rejeitar. */
export class ServiceTeamNotSelectedError extends Error {
  constructor(
    readonly patientId: string,
    readonly serviceId: string,
    readonly workerId: string,
  ) {
    super(`Worker is not a selectable candidate of this service: ${workerId} (serviceId=${serviceId})`);
    this.name = 'ServiceTeamNotSelectedError';
  }
}

/** Reverter quem não tem marca ATIVA (nunca rejeitado, ou já revertido). */
export class ServiceTeamNotRejectedError extends Error {
  constructor(
    readonly patientId: string,
    readonly serviceId: string,
    readonly workerId: string,
  ) {
    super(`Worker is not rejected in this service: ${workerId} (serviceId=${serviceId})`);
    this.name = 'ServiceTeamNotRejectedError';
  }
}

/** Corrida no índice `uq_csr_active_pair` (23505): outra rejeição do mesmo par venceu antes do INSERT. */
export class ServiceTeamAlreadyRejectedError extends Error {
  constructor(
    readonly patientId: string,
    readonly serviceId: string,
    readonly workerId: string,
  ) {
    super(`Worker already has an active rejection in this service: ${workerId} (serviceId=${serviceId})`);
    this.name = 'ServiceTeamAlreadyRejectedError';
  }
}

/** O 23505 que é a corrida do índice `uq_csr_active_pair` — e só ele (molde `isCaseNumberConflict`). */
function isActiveRejectionConflict(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string; constraint?: string };
  return e.code === '23505' && e.constraint === 'uq_csr_active_pair';
}

export interface ServiceTeamMarkInput {
  patientId: string;
  serviceId: string;
  workerId: string;
  reasonCategory: unknown;
  actorUid: string;
  /** `null` = engine de permissão não decidiu nesta request (D113). */
  cells: string[] | null;
  now?: Date;
}

export interface ServiceTeamMarkReaderPort {
  readWith(client: PoolClient, patientId: string, serviceId: string): Promise<ServiceTeamRows | null>;
}

export interface ServiceTeamMarkWriterPort {
  insertRejection(client: PoolClient, input: { serviceId: string; workerId: string; category: string; actorUid: string }): Promise<void>;
  revertRejection(
    client: PoolClient,
    input: { serviceId: string; workerId: string; category: string; actorUid: string },
  ): Promise<number>;
}

type TransactionRunner = <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;

export class ServiceTeamMarkUseCase {
  constructor(
    private readonly reader: ServiceTeamMarkReaderPort = new ServiceTeamReader(),
    private readonly writer: ServiceTeamMarkWriterPort = new ServiceTeamMarkWriter(),
    private readonly kms: Decryptor = new KMSEncryptionService(),
    private readonly runInTransaction: TransactionRunner = inPatientTransaction,
  ) {}

  async reject(input: ServiceTeamMarkInput): Promise<GetServiceTeamResult> {
    return this.mark('REJECT', input);
  }

  async revert(input: ServiceTeamMarkInput): Promise<GetServiceTeamResult> {
    return this.mark('REVERT', input);
  }

  private async mark(kind: ServiceTeamReasonKind, input: ServiceTeamMarkInput): Promise<GetServiceTeamResult> {
    const { patientId, serviceId, workerId, reasonCategory, actorUid, cells, now = new Date() } = input;

    if (reasonCategory === undefined || reasonCategory === null || reasonCategory === '') {
      throw new ServiceTeamReasonRequiredError(kind);
    }
    if (!isAllowedServiceTeamReason(kind, reasonCategory)) {
      throw new ServiceTeamReasonInvalidError(kind);
    }
    const category = reasonCategory as string;

    return this.runInTransaction((client) =>
      kind === 'REJECT'
        ? this.runReject(client, patientId, serviceId, workerId, category, actorUid, cells, now)
        : this.runRevert(client, patientId, serviceId, workerId, category, actorUid, cells, now),
    );
  }

  private async runReject(
    client: PoolClient,
    patientId: string,
    serviceId: string,
    workerId: string,
    category: string,
    actorUid: string,
    cells: string[] | null,
    now: Date,
  ): Promise<GetServiceTeamResult> {
    const row = await this.reader.readWith(client, patientId, serviceId);
    if (row === null) throw new ServiceTeamNotFoundError(patientId, serviceId);

    const team = this.deriveTeam(row, now);
    if (team.inService.some((m) => m.workerId === workerId)) {
      throw new ServiceTeamWorkerAllocatedError(patientId, serviceId, workerId);
    }
    if (!team.selected.some((m) => m.workerId === workerId)) {
      throw new ServiceTeamNotSelectedError(patientId, serviceId, workerId);
    }

    try {
      await this.writer.insertRejection(client, { serviceId: row.serviceId, workerId, category, actorUid });
    } catch (err) {
      if (isActiveRejectionConflict(err)) throw new ServiceTeamAlreadyRejectedError(patientId, serviceId, workerId);
      throw err;
    }

    return this.recompute(client, patientId, serviceId, cells, now);
  }

  private async runRevert(
    client: PoolClient,
    patientId: string,
    serviceId: string,
    workerId: string,
    category: string,
    actorUid: string,
    cells: string[] | null,
    now: Date,
  ): Promise<GetServiceTeamResult> {
    const row = await this.reader.readWith(client, patientId, serviceId);
    if (row === null) throw new ServiceTeamNotFoundError(patientId, serviceId);

    const team = this.deriveTeam(row, now);
    if (!team.rejected.some((m) => m.workerId === workerId)) {
      throw new ServiceTeamNotRejectedError(patientId, serviceId, workerId);
    }

    const rowCount = await this.writer.revertRejection(client, { serviceId: row.serviceId, workerId, category, actorUid });
    if (rowCount === 0) throw new ServiceTeamNotRejectedError(patientId, serviceId, workerId);

    return this.recompute(client, patientId, serviceId, cells, now);
  }

  /** Relê (mesmo client) e recalcula — a escrita já aconteceu; a resposta é o time ATUAL. */
  private async recompute(
    client: PoolClient,
    patientId: string,
    serviceId: string,
    cells: string[] | null,
    now: Date,
  ): Promise<GetServiceTeamResult> {
    const row = await this.reader.readWith(client, patientId, serviceId);
    if (row === null) throw new ServiceTeamNotFoundError(patientId, serviceId);

    const team = this.deriveTeam(row, now);
    const displayNameByWorkerId = await projectServiceTeamDisplayNames(row, team, cells, this.kms);

    return buildServiceTeamResult(row, team, displayNameByWorkerId);
  }

  private deriveTeam(row: ServiceTeamRows, now: Date) {
    const asOf = operationDateOf(row.country, now);
    return deriveServiceTeam({
      serviceId: row.serviceId,
      liveVacancyId: row.liveVacancyId,
      asOf,
      candidacies: row.candidacies,
      assignments: row.assignments,
      marks: row.marks,
    });
  }
}
