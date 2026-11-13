/**
 * ListJobsByRadiusForWorkerUseCase — `GET /api/workers/me/jobs?radius_km=` (spec 077 C-37, D661).
 *
 * Raio só de `JOB_RADII_KM` (5/10/15/20/50/100); fora disso INVALID_RADIUS sem tocar o banco. Identidade SÓ pelo `uid`
 * do token: o prestador sai de `workers.auth_uid` dentro de `withActorContext` (conexão crua do pool cai na RLS de
 * país, mesma régua do GetWorkerItineraryUseCase). Prestador inexistente ou DISABLED → ACCOUNT_INACTIVE; sem zona viva
 * com ponto → NO_SERVICE_AREA (o app mostra a tela de cadastrar endereço, VG-06).
 */
import type { PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { withActorContext } from '@shared/database/actorContext';
import { readJobsByRadius, type WorkerJobByRadius } from '../infrastructure/WorkerJobsByRadiusReader';

export const JOB_RADII_KM = [5, 10, 15, 20, 50, 100] as const;

export type ListJobsByRadiusResult =
  | { ok: true; items: WorkerJobByRadius[] }
  | { ok: false; code: 'INVALID_RADIUS' | 'NO_SERVICE_AREA' | 'ACCOUNT_INACTIVE' };

type RunInActorContext = <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;
type JobsReader = typeof readJobsByRadius;

const runWithPool: RunInActorContext = (fn) => withActorContext(DatabaseConnection.getInstance().getPool(), fn);

export class ListJobsByRadiusForWorkerUseCase {
  constructor(
    private readonly run: RunInActorContext = runWithPool,
    private readonly reader: JobsReader = readJobsByRadius,
  ) {}

  async execute(authUid: string, radiusKm: number): Promise<ListJobsByRadiusResult> {
    if (!(JOB_RADII_KM as readonly number[]).includes(radiusKm)) return { ok: false, code: 'INVALID_RADIUS' };
    return this.run(async (client) => {
      const found = await client.query<{ id: string; status: string }>(
        'SELECT id, status FROM workers WHERE auth_uid = $1 LIMIT 1',
        [authUid],
      );
      const worker = found.rows[0];
      if (!worker || worker.status === 'DISABLED') return { ok: false, code: 'ACCOUNT_INACTIVE' } as const;
      const items = await this.reader(client, { workerId: worker.id, radiusKm });
      if (items === null) return { ok: false, code: 'NO_SERVICE_AREA' } as const;
      return { ok: true, items } as const;
    });
  }
}
