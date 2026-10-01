/**
 * ServiceTeamMarkUseCase — quadro C (Servicio Contratado), Fase 10, DX-10.6 (2).
 *
 * `reject` e `revert`: a ordem é a régua da sabotagem — motivo ausente SEMPRE antes do banco
 * (`ServiceTeamReasonRequiredError`, `serviceTeamReason.ts`). REVERT: motivo fora da lista fechada
 * também antes do banco (`ServiceTeamReasonInvalidError`). REJECT (change itinerario-trocas-motivos-e-figma,
 * Fase 2, D2): a lista é o CATÁLOGO `service_exit_reasons` — o código tem de existir e estar ATIVO,
 * conferido (`ServiceExitReasonReader.findActiveByCode`) DENTRO da transação e ANTES de qualquer
 * leitura/escrita do time; inexistente/inativo → o mesmo `ServiceTeamReasonInvalidError` (422 de
 * hoje). Só depois abre `inPatientTransaction`. Dentro da transação: lê o time
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
import {
  isAllowedServiceTeamRevertReason,
  ServiceTeamReasonRequiredError,
  ServiceTeamReasonInvalidError,
  type ServiceTeamReasonKind,
} from '../domain/serviceTeamReason';
import { ServiceTeamReader, type ServiceTeamRows } from '../infrastructure/ServiceTeamReader';
import { ServiceTeamMarkWriter } from '../infrastructure/ServiceTeamMarkWriter';
import { ServiceExitReasonReader, type ServiceExitReasonOption } from '../infrastructure/ServiceExitReasonReader';
import { ServiceTeamNotFoundError, type GetServiceTeamResult } from './GetServiceTeamUseCase';
import { deriveServiceTeamFromRows, projectServiceTeamDisplayNames, buildServiceTeamResult } from './serviceTeamPresentation';
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

/** Consulta ao catálogo de motivos de saída (migration 492) — só o que o REJECT precisa. */
export interface ServiceTeamReasonCatalogPort {
  findActiveByCode(client: PoolClient, code: string): Promise<ServiceExitReasonOption | null>;
}

type TransactionRunner = <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;

export class ServiceTeamMarkUseCase {
  constructor(
    private readonly reader: ServiceTeamMarkReaderPort = new ServiceTeamReader(),
    private readonly writer: ServiceTeamMarkWriterPort = new ServiceTeamMarkWriter(),
    private readonly kms: Decryptor = new KMSEncryptionService(),
    private readonly runInTransaction: TransactionRunner = inPatientTransaction,
    private readonly reasonCatalog: ServiceTeamReasonCatalogPort = new ServiceExitReasonReader(),
  ) {}

  async reject(input: ServiceTeamMarkInput): Promise<GetServiceTeamResult> {
    return this.mark('REJECT', input);
  }

  /**
   * Corpo de `reject` no client recebido (change itinerario-trocas-motivos-e-figma, Fase 4, D4): quem
   * compõe (tirar com destino) abre a transação e chama aqui. Mesmas validações de `reject`, mesma
   * escrita; a rejeição não deriva o estado do paciente (quem compõe roda a derivação por último).
   */
  async rejectWith(client: PoolClient, input: ServiceTeamMarkInput): Promise<GetServiceTeamResult> {
    const { patientId, serviceId, workerId, reasonCategory, actorUid, cells, now = new Date() } = input;
    const category = this.validateReason('REJECT', reasonCategory);
    return this.runReject(client, patientId, serviceId, workerId, category, actorUid, cells, now);
  }

  async revert(input: ServiceTeamMarkInput): Promise<GetServiceTeamResult> {
    return this.mark('REVERT', input);
  }

  private async mark(kind: ServiceTeamReasonKind, input: ServiceTeamMarkInput): Promise<GetServiceTeamResult> {
    const { patientId, serviceId, workerId, reasonCategory, actorUid, cells, now = new Date() } = input;
    const category = this.validateReason(kind, reasonCategory);

    return this.runInTransaction((client) =>
      kind === 'REJECT'
        ? this.runReject(client, patientId, serviceId, workerId, category, actorUid, cells, now)
        : this.runRevert(client, patientId, serviceId, workerId, category, actorUid, cells, now),
    );
  }

  /** Motivo ausente/fora da forma SEMPRE antes do banco (mesma régua de `mark` e `rejectWith`). */
  private validateReason(kind: ServiceTeamReasonKind, reasonCategory: unknown): string {
    if (reasonCategory === undefined || reasonCategory === null || reasonCategory === '') {
      throw new ServiceTeamReasonRequiredError(kind);
    }
    if (kind === 'REJECT') {
      if (typeof reasonCategory !== 'string') throw new ServiceTeamReasonInvalidError(kind);
    } else if (!isAllowedServiceTeamRevertReason(reasonCategory)) {
      throw new ServiceTeamReasonInvalidError(kind);
    }
    return reasonCategory as string;
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
    // D2: o motivo de rejeitar é o do catálogo (ativo) — antes de qualquer leitura/escrita do time.
    if ((await this.reasonCatalog.findActiveByCode(client, category)) === null) {
      throw new ServiceTeamReasonInvalidError('REJECT');
    }

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
    return deriveServiceTeamFromRows(row, now);
  }
}
