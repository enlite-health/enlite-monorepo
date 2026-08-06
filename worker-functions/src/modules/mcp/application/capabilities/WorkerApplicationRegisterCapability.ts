import { z } from 'zod';
import type { Pool } from 'pg';
import { luzActor } from '@shared/audit/actorSource';
import type { ApplyToVacancyUseCase } from '../../../matching/application/ApplyToVacancyUseCase';
import type { GetWorkerByIdUseCase } from '../../../worker/application/GetWorkerByIdUseCase';

const ArgsShape = {
  workerId: z.string().uuid(),
  jobPostingId: z.string().uuid(),
};

const ArgsSchema = z.object(ArgsShape);

export type WorkerApplicationRegisterResult =
  | { ok: true; wjaId: string | null }
  | { ok: false; reason: string; workerStatus: string | null; missingFields: string[] };

/**
 * WorkerApplicationRegisterCapability (worker.application.register) — WRITE.
 *
 * A Luz postula o worker numa vaga em pauta na conversa, com PARIDADE de regras
 * com o app (ApplyToVacancyUseCase = mesma composição do endpoint track-channel:
 * elegibilidade + instrumentação de bloqueio + WJA INVITED com encuadre).
 * Canal de aquisição fixo 'luz_whatsapp' (atribuição da conversão da Luz).
 * Inelegível → {ok:false, reason} determinístico (a Luz explica, nunca afirma sucesso).
 */
export class WorkerApplicationRegisterCapability {
  static readonly NAME = 'worker.application.register';
  static readonly DESCRIPTION =
    'Register a job application (postulación) for a worker on a vacancy, with the SAME eligibility rules as the app (REGISTERED only; blocked attempts instrumented). Idempotent per worker×vacancy. Returns {ok:false, reason} when not eligible.';
  static readonly INPUT_SHAPE = ArgsShape;

  constructor(
    private readonly applyToVacancy: ApplyToVacancyUseCase,
    private readonly db: Pool,
    private readonly getWorkerById: GetWorkerByIdUseCase,
  ) {}

  async execute(args: unknown): Promise<WorkerApplicationRegisterResult> {
    const { workerId, jobPostingId } = ArgsSchema.parse(args);

    // Nome/telefone decriptados p/ auditoria do encuadre (paridade com o app).
    // Falha aqui não bloqueia a postulação — a elegibilidade decide.
    let workerName = '';
    let workerPhone = '';
    try {
      const { worker } = await this.getWorkerById.execute(workerId);
      workerName = [worker.firstName, worker.lastName].filter(Boolean).join(' ');
      workerPhone = worker.phone ?? '';
    } catch {
      /* segue com audit vazio */
    }

    const result = await this.applyToVacancy.execute(this.db, {
      workerId,
      jobPostingId,
      acquisitionChannel: 'luz_whatsapp',
      workerName,
      workerPhone,
      // Chamada MCP não tem sessão de painel: sem ator explícito a postulação
      // feita na conversa cairia em `nao_instrumentado`.
      actor: luzActor('apply'),
    });

    if (!result.ok) {
      return {
        ok: false,
        reason: result.reason,
        workerStatus: result.workerStatus,
        missingFields: result.missingFields,
      };
    }

    return { ok: true, wjaId: result.wjaId };
  }
}
