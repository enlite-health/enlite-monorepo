/**
 * AssembleItineraryUseCase — Fase 11, DX-11.8 (caso de uso). "Está montado" = existe linha em
 * `patient_itinerary_assembly` (migration 482, log append-only) — marcar de novo grava linha
 * nova, nunca reescreve a anterior. Não move o paciente (invariante 3, Fase 15) — nenhuma escrita
 * em `patients`.
 *
 * Ordem (molde `ServiceTeamMarkUseCase.ts`, reader/writer/transação injetados): paciente fora da
 * RLS/inexistente → `ItineraryPatientNotFoundError` (404); 0 serviço com vaga viva →
 * `NoServiceWithVacancyError` (422 `NO_SERVICE_WITH_VACANCY` — montar nada não é montar); algum
 * serviço com vaga viva sem slot `active` → `ServiceWithoutSlotError` (422 `SERVICE_WITHOUT_SLOT`,
 * nomeando o serviço por id + código do tipo, sem texto clínico); senão `insertAssembly`.
 */
import type { PoolClient } from 'pg';
import { inPatientTransaction } from './patientTransaction';
import {
  ItineraryAssemblyWriter,
  type ServiceMissingSlot,
  type ServicesMissingSlotResult,
  type InsertedAssembly,
} from '../infrastructure/ItineraryAssemblyWriter';

/** Paciente inexistente, soft-deletado, ou fora da RLS — o controller mapeia para 404. */
export class ItineraryPatientNotFoundError extends Error {
  constructor(readonly patientId: string) {
    super(`Patient not found for itinerary assembly: ${patientId}`);
    this.name = 'ItineraryPatientNotFoundError';
  }
}

/** Nenhum serviço contratado ativo tem vaga viva — montar nada não é montar. */
export class NoServiceWithVacancyError extends Error {
  readonly code = 'NO_SERVICE_WITH_VACANCY';
  constructor(readonly patientId: string) {
    super(`No contracted service with a live vacancy for this patient: ${patientId}`);
    this.name = 'NoServiceWithVacancyError';
  }
}

/** Ao menos 1 serviço com vaga viva ainda não tem slot `active` — nomeado por id + código do tipo. */
export class ServiceWithoutSlotError extends Error {
  readonly code = 'SERVICE_WITHOUT_SLOT';
  constructor(readonly services: ServiceMissingSlot[]) {
    super(`Services with a live vacancy but no active itinerary slot: ${services.map((s) => s.serviceId).join(', ')}`);
    this.name = 'ServiceWithoutSlotError';
  }
}

export interface ItineraryAssemblyWriterPort {
  patientExists(client: PoolClient, patientId: string): Promise<boolean>;
  servicesMissingSlot(client: PoolClient, patientId: string): Promise<ServicesMissingSlotResult>;
  insertAssembly(client: PoolClient, patientId: string, actorUid: string): Promise<InsertedAssembly>;
}

type TransactionRunner = <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;

export interface AssembleItineraryInput {
  patientId: string;
  actorUid: string;
}

export interface AssembleItineraryResult {
  patientId: string;
  assembledAt: string;
}

export class AssembleItineraryUseCase {
  constructor(
    private readonly writer: ItineraryAssemblyWriterPort = new ItineraryAssemblyWriter(),
    private readonly runInTransaction: TransactionRunner = inPatientTransaction,
  ) {}

  async execute(input: AssembleItineraryInput): Promise<AssembleItineraryResult> {
    const { patientId, actorUid } = input;
    return this.runInTransaction(async (client) => {
      const exists = await this.writer.patientExists(client, patientId);
      if (!exists) throw new ItineraryPatientNotFoundError(patientId);

      const { services, countWithLiveVacancy } = await this.writer.servicesMissingSlot(client, patientId);
      if (countWithLiveVacancy === 0) throw new NoServiceWithVacancyError(patientId);
      if (services.length > 0) throw new ServiceWithoutSlotError(services);

      const inserted = await this.writer.insertAssembly(client, patientId, actorUid);
      return { patientId, assembledAt: inserted.assembledAt };
    });
  }
}
