import { IWorkerRepository } from '../ports/IWorkerRepository';
import { SavePersonalInfoDTO, Worker } from '../domain/Worker';
import { WORKER_ERROR_CODES } from '../domain/workerErrors';
import { Result } from '@shared/utils/Result';
import { normalizePhoneAR, generatePhoneCandidates } from '@shared/utils/phoneNormalization';
import type { Pool } from 'pg';
import { logger, loggingAls } from '@shared/logging';
import { enqueueDomainEvent } from '@shared/events/enqueueDomainEvent';
import type { PubSubClient } from '@shared/events/PubSubClient';
import { ProfileChangeAuditRepository } from '../infrastructure/ProfileChangeAuditRepository';
import { redactProfileValue } from './profileChangeRedaction';
import { logProfileEdit } from '../domain/profileEditSource';
import { captureWorkerBefore } from './workerAuditDiff';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { isValidIsoBirthDate } from '@shared/utils/isValidIsoBirthDate';

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

    // Defeito 1 (21/09/2026): `birthDate` chegava sem validação nenhuma — qualquer
    // string ia direto pro encrypt (ver openapi WorkerGeneralInfoBody, só documentação,
    // e o controller `saveGeneralInfo` que espalha `req.body` cru). Vazio/ausente
    // continua permitido (é "mantém o valor atual" via COALESCE no repositório).
    if (data.birthDate && !isValidIsoBirthDate(data.birthDate)) {
      return Result.fail<Worker>('Invalid birth date. Expected YYYY-MM-DD with a real, non-future date.');
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

    // Snapshot "antes" pro diff da trilha de fonte — findById NÃO hidrata os
    // campos pessoais (só básicos), então o diff precisa do captureWorkerBefore
    // (decriptado). Capturado ANTES do update; null = trilha é pulada.
    const beforeSnapshot = await this.captureBeforeSafe(data.workerId);

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

    // Trilha de fonte: o prestador editando o próprio cadastro deixava ZERO
    // rastro (self cego — change luz-cadastro-assistido-rastreavel). Grava
    // worker_profile_changes_audit com changed_by='worker_self', só pros campos
    // que MUDARAM de verdade (o wizard reenvia o form inteiro a cada save).
    // Best-effort como o mirror event: falha de audit não derruba o save.
    if (beforeSnapshot) {
      await this.recordSelfEditTrail(data, beforeSnapshot);
    }

    // Enqueue worker.mirror_requested (outbox best-effort).
    // updatePersonalInfo does not use an explicit transaction, so the INSERT
    // runs after — not atomic, but the DomainEventProcessor sweep is the
    // durability net. recalculateStatus already enqueues when reaching
    // REGISTERED atomically; this covers profile edits that don't change status.
    await this.enqueueMirrorEvent(data.workerId);

    return Result.ok<Worker>(updateResult.getValue());
  }

  // ── Trilha de fonte (worker_self) ───────────────────────────────

  private async captureBeforeSafe(workerId: string): Promise<Record<string, unknown> | null> {
    try {
      return await captureWorkerBefore(this.getPool(), new KMSEncryptionService(), workerId);
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      logger.child({ workerId }).warn({
        msg: `${TAG} failed to capture before-snapshot for edit trail (best-effort, ignoring)`,
        error: e.message,
      });
      return null;
    }
  }

  private async recordSelfEditTrail(
    data: SavePersonalInfoDTO,
    before: Record<string, unknown>,
  ): Promise<void> {
    try {
      const changed = diffPersonalInfo(data, before);
      if (changed.length === 0) return;

      await new ProfileChangeAuditRepository(this.getPool()).recordBatch(
        changed.map(({ field, oldValue, newValue }) => ({
          workerId: data.workerId,
          pendingChangeId: null,
          fieldName: field,
          oldValueRedacted:
            oldValue === '' ? null : redactProfileValue(field, oldValue),
          newValueRedacted: redactProfileValue(field, newValue),
          changedBy: 'worker_self',
          source: 'platform',
          conversationRef: null,
        })),
      );
      for (const { field } of changed) {
        logProfileEdit(data.workerId, field, 'worker_self');
      }
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      logger.child({ workerId: data.workerId }).warn({
        msg: `${TAG} failed to record self edit trail (best-effort, ignoring)`,
        error: e.message,
      });
    }
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

// ── Diff DTO × snapshot "antes" ───────────────────────────────────
//
// O wizard reenvia TODOS os campos a cada save; sem diff, um save viraria ~15
// linhas de "edição" falsas na trilha. Compara com o captureWorkerBefore
// (decriptado — findById NÃO hidrata os pessoais) e devolve só o que mudou.
// sex/gender ficam fora: o snapshot compartilhado não os cobre e, sem "antes",
// entrariam como falso-mudado em todo save.

interface SelfEditDiff {
  field: string;
  oldValue: string;
  newValue: string;
}

const SELF_TRACKED_FIELDS: Array<keyof SavePersonalInfoDTO> = [
  'firstName',
  'lastName',
  'documentType',
  'documentNumber',
  'languages',
  'profession',
  'knowledgeLevel',
  'titleCertificate',
  'experienceTypes',
  'yearsExperience',
  'preferredTypes',
  'preferredAgeRange',
];

function diffPersonalInfo(data: SavePersonalInfoDTO, before: Record<string, unknown>): SelfEditDiff[] {
  const diffs: SelfEditDiff[] = [];

  for (const field of SELF_TRACKED_FIELDS) {
    const incoming = normalizeForDiff(data[field]);
    if (incoming === '') continue; // vazio não sobrescreve (COALESCE no repo)
    const existing = normalizeForDiff(before[field]);
    if (incoming !== existing) {
      diffs.push({ field, oldValue: existing, newValue: incoming });
    }
  }

  // birthDate: compara por YYYY-MM-DD (os dois lados chegam como string ISO).
  const incomingBirth = (data.birthDate ?? '').slice(0, 10);
  if (incomingBirth !== '') {
    const existingBirth = normalizeForDiff(before.birthDate).slice(0, 10);
    if (incomingBirth !== existingBirth) {
      diffs.push({ field: 'birthDate', oldValue: existingBirth, newValue: incomingBirth });
    }
  }

  return diffs;
}

function normalizeForDiff(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).join(', ');
  return String(value).trim();
}
