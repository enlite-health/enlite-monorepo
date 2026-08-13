import { z } from 'zod';
import type {
  ListWorkerApplicationsUseCase,
  ListWorkerApplicationsResult,
} from '../../../matching/application/ListWorkerApplicationsUseCase';

const ArgsShape = {
  workerId: z.string().uuid(),
};

const ArgsSchema = z.object(ArgsShape);

/**
 * WorkerApplicationsListCapability (worker.applications.list) — READ.
 *
 * As postulações do PRÓPRIO worker (caso + etapa amigável + data), pra Luz
 * responder "¿llegó mi postulación?" (D89 item 5 — gap achado na jornada
 * adversarial 04/08). Nenhum dado de paciente no retorno.
 */
export class WorkerApplicationsListCapability {
  static readonly NAME = 'worker.applications.list';
  static readonly DESCRIPTION =
    "List a worker's own job applications (case title, friendly stage, applied date). No patient data.";
  static readonly INPUT_SHAPE = ArgsShape;

  constructor(private readonly useCase: ListWorkerApplicationsUseCase) {}

  async execute(args: unknown): Promise<ListWorkerApplicationsResult> {
    const parsed = ArgsSchema.parse(args);
    return this.useCase.execute(parsed.workerId);
  }
}
