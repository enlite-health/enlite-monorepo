import { Pool } from 'pg';
import { withActorContext } from '@shared/database/actorContext';
import type { ActorContext } from '@shared/audit/actorSource';
import {
  assertWorkerCanApply,
  WorkerNotEligibleError,
  type WorkerEligibilityReason,
} from '../domain/WorkerApplicationEligibility';
import { RecordBlockedAttemptUseCase } from './RecordBlockedAttemptUseCase';
import { CreateManualWjaWithEncuadreUseCase } from './CreateManualWjaWithEncuadreUseCase';

export interface ApplyToVacancyParams {
  workerId: string;
  jobPostingId: string;
  /** Canal de aquisição (facebook, luz_whatsapp, etc.) ou null quando ausente. */
  acquisitionChannel: string | null;
  /** Nome decriptado do worker (auditoria worker_raw_name do encuadre). */
  workerName?: string;
  /** Telefone do worker (auditoria worker_raw_phone do encuadre). */
  workerPhone?: string;
  /**
   * Quem está postulando. Omitido, usa o ator da request (ALS) — que no app é o
   * próprio prestador. A capability da Luz passa `luzActor('apply')`, senão a
   * postulação feita na conversa não teria ator (chamada MCP não tem sessão de
   * painel) e cairia em `nao_instrumentado`.
   */
  actor?: ActorContext;
}

export type ApplyToVacancyResult =
  | { ok: true; wjaId: string | null }
  | {
      ok: false;
      code: 'WORKER_NOT_ELIGIBLE';
      httpStatus: number;
      reason: WorkerEligibilityReason;
      workerStatus: string | null;
      missingFields: string[];
    };

/**
 * ApplyToVacancyUseCase — postulação de um worker numa vaga, com as MESMAS
 * regras do endpoint do app (fonte única de elegibilidade).
 *
 * Extraído de WorkerApplicationsController.trackChannel (linhas 104-141 antes
 * da extração): compõe assertWorkerCanApply + RecordBlockedAttemptUseCase +
 * CreateManualWjaWithEncuadreUseCase. O controller delega; a capability MCP
 * da Luz (worker.application.register) chamará o mesmo use case.
 *
 * Erros de infraestrutura (banco fora etc.) PROPAGAM — só a inelegibilidade
 * vira {ok:false} semântico.
 */
export class ApplyToVacancyUseCase {
  constructor(
    private readonly recordBlockedAttemptUseCase: RecordBlockedAttemptUseCase = new RecordBlockedAttemptUseCase(),
    private readonly createManualWjaWithEncuadreUseCase: CreateManualWjaWithEncuadreUseCase = new CreateManualWjaWithEncuadreUseCase(),
  ) {}

  async execute(db: Pool, params: ApplyToVacancyParams): Promise<ApplyToVacancyResult> {
    const { workerId, jobPostingId, acquisitionChannel, workerName, workerPhone, actor } = params;

    try {
      await assertWorkerCanApply(db, workerId);
    } catch (err) {
      if (err instanceof WorkerNotEligibleError) {
        // Instrumenta a tentativa bloqueada. Awaited de propósito: em Cloud Run,
        // trabalho em background após o response é estrangulado/descartado, o que
        // perderia a gravação. A conexão já está quente (assertWorkerCanApply acima)
        // e o upsert é single-row indexado (latência sub-ms). O use case é à prova de
        // falha (try/catch interno, nunca lança), então o caller nunca é bloqueado por erro.
        const missingFields = await this.recordBlockedAttemptUseCase.execute({
          workerId,
          jobPostingId,
          reason: err.reason,
          acquisitionChannel,
        });
        return {
          ok: false,
          code: err.code,
          httpStatus: err.status,
          reason: err.reason,
          workerStatus: err.workerStatus,
          missingFields,
        };
      }
      throw err;
    }

    // Transação com carimbo de ator: o trigger de histórico grava quem postulou
    // (a Luz na conversa × o próprio prestador no app) — ver actorContext.
    const { wjaId } = await withActorContext(
      db,
      (client) =>
        this.createManualWjaWithEncuadreUseCase.execute(client, {
          workerId,
          jobPostingId,
          acquisitionChannel,
          workerName,
          workerPhone,
        }),
      actor,
    );

    return { ok: true, wjaId };
  }
}
