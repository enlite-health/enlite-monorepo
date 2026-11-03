import type { Pool } from 'pg';
import type { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { generatePhoneCandidates } from '@shared/utils/phoneNormalization';
import { currentDbContext } from '@shared/database/requestDbSession';
import { recordResourceAccess, resolveAccessOrigin } from '@shared/audit/resourceAccessLog';
import { WORKER_DETAIL_COLS } from '../../worker/interfaces/controllers/AdminWorkersControllerHelpers';
import { buildWorkerDetailResponse } from '../../worker/interfaces/controllers/AdminWorkersDetailBuilder';
import type { GCSStorageService } from '../../worker/infrastructure/GCSStorageService';
import type { WorkerAccessTrail, WorkerDetailByPhone } from '../application/capabilities/WorkerByPhoneCapability';

/**
 * Mesma busca e mesma ficha do `AdminWorkersController.getWorkerByPhone` (REST), sem Express. Ficha INTEIRA (`cells = null`), como o REST dá
 * ao principal de serviço (D113): a projeção por célula do grupo espelho é decisão de semântica, vai para a LISTA.
 */
export class WorkerDetailByPhoneLookup implements WorkerDetailByPhone {
  constructor(
    private readonly db: Pool,
    private readonly kms: KMSEncryptionService,
    private readonly gcs: GCSStorageService,
  ) {}

  async findByPhone(phone: string): Promise<{ workerId: string; data: Record<string, unknown> } | null> {
    const candidates = generatePhoneCandidates(phone);
    if (candidates.length === 0) return null;
    const r = await this.db.query(
      `SELECT ${WORKER_DETAIL_COLS} FROM workers w WHERE w.phone = ANY($1::text[]) AND w.merged_into_id IS NULL`,
      [candidates],
    );
    if (r.rows.length === 0) return null;
    const data = await buildWorkerDetailResponse(this.db, this.kms, this.gcs, r.rows[0], null);
    return { workerId: r.rows[0].id as string, data };
  }
}

/** Trilha em `resource_access_log` (mesma tabela da rota REST), com a origem classificada pelo contexto do ator. */
export class ResourceAccessWorkerTrail implements WorkerAccessTrail {
  async record(entry: { operatorUid: string; workerId: string; action: string }): Promise<void> {
    const origin = await resolveAccessOrigin(currentDbContext(), 'worker', entry.workerId);
    await recordResourceAccess({
      operatorUid: entry.operatorUid,
      operatorRole: 'agent',
      resourceType: 'worker',
      resourceId: entry.workerId,
      action: entry.action,
      origin,
    });
  }
}
