import { z } from 'zod';
import { logger } from '../../../../shared/logging/Logger';

const ArgsShape = { phone: z.string().min(5) };
const ArgsSchema = z.object(ArgsShape);

/** Resolve o prestador pelo telefone e devolve a ficha (a MESMA que a rota REST irmã `GET /workers/by-phone`). `null` = não achou. */
export interface WorkerDetailByPhone {
  findByPhone(phone: string): Promise<{ workerId: string; data: Record<string, unknown> } | null>;
}

/** Trilha de leitura do dossiê (`resource_access_log`): só o UUID do prestador — NUNCA o telefone (C6). */
export interface WorkerAccessTrail {
  record(entry: { operatorUid: string; workerId: string; action: string }): Promise<void>;
}

/**
 * WorkerByPhoneCapability (worker.byPhone) — célula `worker_pii:read` (a da rota REST irmã; classe (a), roda como o ATOR).
 * Abre o dossiê inteiro, por isso grava a trilha de acesso (como o `logResourceAccess('worker', 'read_by_phone', ...)` da rota): o id
 * da trilha é o que o handler RESOLVEU, não o telefone. A trilha é fail-safe (erro dela não derruba a leitura, como no REST).
 */
export class WorkerByPhoneCapability {
  static readonly NAME = 'worker.byPhone';
  static readonly DESCRIPTION =
    'Find a worker by phone number and return the worker record (same payload as the admin by-phone lookup). Returns {found:false} when there is no match.';
  static readonly INPUT_SHAPE = ArgsShape;

  constructor(
    private readonly lookup: WorkerDetailByPhone,
    private readonly trail: WorkerAccessTrail,
  ) {}

  async execute(args: unknown, principalName?: string): Promise<{ found: false } | { found: true; worker: Record<string, unknown> }> {
    const { phone } = ArgsSchema.parse(args);
    const hit = await this.lookup.findByPhone(phone);
    if (!hit) return { found: false };
    await this.trail.record({ operatorUid: principalName ?? 'agent', workerId: hit.workerId, action: 'read_by_phone' }).catch((err: unknown) => logger.warn({ action: 'read_by_phone', err: err instanceof Error ? err.message : 'unknown' }, 'worker.byPhone: trilha de acesso falhou (leitura segue)'));
    return { found: true, worker: hit.data };
  }
}
