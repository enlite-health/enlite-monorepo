import { IWorkerRepository } from '../ports/IWorkerRepository';
import { SavePersonalInfoDTO, Worker } from '../domain/Worker';
import { WORKER_ERROR_CODES } from '../domain/workerErrors';
import { Result } from '@shared/utils/Result';
import { normalizePhoneAR, generatePhoneCandidates } from '@shared/utils/phoneNormalization';
import type { Pool } from 'pg';
import { logger, loggingAls } from '@shared/logging';
import { enqueueDomainEvent } from '@shared/events/enqueueDomainEvent';
import type { PubSubClient } from '@shared/events/PubSubClient';

const TAG = '[SavePersonalInfoUseCase]';
const MIRROR_EVENT = 'worker.mirror_requested';
const MIRROR_TOPIC = 'worker-mirror-requested';

export class SavePersonalInfoUseCase {
  private readonly workerRepository: IWorkerRepository;
  private readonly pubsub: PubSubClient | null;
  /**
   * Pool injetado para enqueue de domain_events.
   * Quando null (default em unit tests), resolvido lazy via DatabaseConnection
   * na primeira chamada — evita chamar getInstance() no construtor, que requer
   * DATABASE_URL nos testes unitários.
   */
  private readonly injectedPool: Pool | null;

  constructor(
    workerRepository: IWorkerRepository,
    /** Pool injetado. Omitir em produção → usa DatabaseConnection singleton. */
    pool?: Pool,
    /** PubSubClient injetado. Omitir em produção → sem publish imediato. */
    pubsub?: PubSubClient,
  ) {
    this.workerRepository = workerRepository;
    this.injectedPool = pool ?? null;
    this.pubsub = pubsub ?? null;
  }

  private getPool(): Pool {
    if (this.injectedPool) return this.injectedPool;
    // Lazy import para não exigir DATABASE_URL no construtor
    const { DatabaseConnection } = require('@shared/database/DatabaseConnection') as typeof import('@shared/database/DatabaseConnection');
    return DatabaseConnection.getInstance().getPool();
  }

  async execute(data: SavePersonalInfoDTO): Promise<Result<Worker>> {
    const workerResult = await this.workerRepository.findById(data.workerId);

    if (workerResult.isFailure) {
      return Result.fail<Worker>(workerResult.error!);
    }

    const worker = workerResult.getValue();
    if (!worker) {
      return Result.fail<Worker>('Worker not found');
    }

    // Resolve o telefone a persistir.
    //
    // A coluna `workers.phone` (plaintext) tem índice único parcial
    // (idx_workers_phone_unique). Como a base tem workers duplicados pelo mesmo
    // número em formatos históricos diferentes, gravar o telefone cru aqui
    // causava `duplicate key value violates unique constraint` ao completar o
    // perfil — mesmo quando o worker não estava trocando o número, só fazendo
    // round-trip do valor já armazenado num formato distinto.
    //
    // Regra:
    //  - Normaliza o número recebido e o atual para o formato canônico (549...).
    //  - Se forem iguais (round-trip) OU o recebido for vazio: NÃO toca no phone
    //    (mantém o valor atual via COALESCE no repo) → caso comum, nunca colide.
    //  - Se houve troca real: garante que o número não pertence a outro worker.
    //    Se pertencer, bloqueia com código estável (mensagem amigável definida
    //    na borda) — sem revelar que o número está em outra conta.
    const phoneToPersist = await this.resolvePhoneToPersist(data.workerId, data.phone, worker.phone);
    if (phoneToPersist.isFailure) {
      return Result.fail<Worker>(phoneToPersist.error!);
    }

    const updateResult = await this.workerRepository.updatePersonalInfo({
      workerId: data.workerId,
      firstName: data.firstName,
      lastName: data.lastName,
      sex: data.sex,
      gender: data.gender,
      birthDate: data.birthDate,
      documentType: data.documentType,
      documentNumber: data.documentNumber,
      phone: phoneToPersist.getValue(),
      profilePhotoUrl: data.profilePhotoUrl,
      languages: data.languages,
      profession: data.profession,
      knowledgeLevel: data.knowledgeLevel,
      titleCertificate: data.titleCertificate,
      experienceTypes: data.experienceTypes,
      yearsExperience: data.yearsExperience,
      preferredTypes: data.preferredTypes,
      preferredAgeRange: data.preferredAgeRange,
      termsAccepted: data.termsAccepted === true,
      privacyAccepted: data.privacyAccepted === true,
    });

    if (updateResult.isFailure) {
      return updateResult;
    }

    await this.workerRepository.recalculateStatus(data.workerId);

    // Enqueue worker.mirror_requested (outbox best-effort).
    // updatePersonalInfo does not use an explicit transaction, so the INSERT
    // runs after — not atomic, but the DomainEventProcessor sweep is the
    // durability net. recalculateStatus already enqueues when reaching
    // REGISTERED atomically; this covers profile edits that don't change status.
    await this.enqueueMirrorEvent(data.workerId);

    return Result.ok<Worker>(updateResult.getValue());
  }

  // ── Enqueue outbox ──────────────────────────────────────────────

  private async enqueueMirrorEvent(workerId: string): Promise<void> {
    try {
      const traceId = loggingAls.getStore()?.traceId ?? null;
      const eventId = await enqueueDomainEvent(this.getPool(), {
        event: MIRROR_EVENT,
        payload: { workerId },
        traceId,
        pubsub: this.pubsub ?? undefined,
        topic: MIRROR_TOPIC,
      });
      logger.child({ workerId, eventId }).debug({ msg: `${TAG} mirror event enqueued` });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      logger.child({ workerId }).warn({
        msg: `${TAG} failed to enqueue mirror event (best-effort, ignoring)`,
        error: e.message,
      });
    }
  }

  /**
   * Decide o valor de `phone` a gravar.
   *
   * Retorna string vazia quando o telefone NÃO deve ser alterado (round-trip do
   * próprio número ou entrada vazia) — o repositório usa COALESCE e mantém o
   * valor atual. Retorna o número canônico quando há troca real e válida.
   * Falha com PHONE_NOT_AVAILABLE quando o número (normalizado) já pertence a
   * outro worker.
   */
  private async resolvePhoneToPersist(
    workerId: string,
    incomingPhone: string | undefined,
    currentPhone: string | undefined,
  ): Promise<Result<string>> {
    const incomingNorm = normalizePhoneAR(incomingPhone);

    // Entrada vazia ou número inalterado → mantém o valor atual (não colide).
    if (!incomingNorm || incomingNorm === normalizePhoneAR(currentPhone)) {
      return Result.ok<string>('');
    }

    // Troca real: o número não pode pertencer a outro worker.
    const candidates = generatePhoneCandidates(incomingPhone ?? '');
    const ownerResult = await this.workerRepository.findByPhoneCandidates(candidates);
    if (ownerResult.isFailure) {
      return Result.fail<string>(ownerResult.error!);
    }
    const owner = ownerResult.getValue();
    if (owner && owner.id !== workerId) {
      return Result.fail<string>(WORKER_ERROR_CODES.PHONE_NOT_AVAILABLE);
    }

    return Result.ok<string>(incomingNorm);
  }
}
