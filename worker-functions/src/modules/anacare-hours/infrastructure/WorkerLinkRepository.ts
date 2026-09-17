/**
 * src/modules/anacare-hours/infrastructure/WorkerLinkRepository.ts
 *
 * Vínculo prestador (D349, item 1): `workers.ana_care_id` já é populado pelo `MirrorWorkerService`
 * (D195) ao espelhar o worker para o Ana Care — este repositório só faz o lookup inverso
 * (ana_care_id → worker) que o módulo `anacare-hours` nunca fazia.
 *
 * Nome vem CIFRADO — decidir se descriptografa é do CHAMADOR (gated por `worker_contact:read`,
 * mesmo corte que `AnaCareHoursMapper` já aplica à nota clínica via `canReadNote`). Buscar SEMPRE
 * em LOTE por todos os `anaCareNurseId` distintos do mês — nunca um SELECT por turno (N+1).
 */

import type { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';

export interface WorkerLinkRow {
  workerId: string;
  firstNameEncrypted: string | null;
  lastNameEncrypted: string | null;
}

interface WorkerLinkRowSql {
  ana_care_id: string;
  id: string;
  first_name_encrypted: string | null;
  last_name_encrypted: string | null;
}

export class WorkerLinkRepository {
  private readonly pool: Pool;

  constructor(pool?: Pool) {
    this.pool = pool ?? DatabaseConnection.getInstance().getPool();
  }

  /** Chave = `ana_care_id` (o `anaCareNurseId` do turno). Presença na Map = vínculo existe. */
  async findByAnaCareIds(anaCareIds: readonly string[]): Promise<Map<string, WorkerLinkRow>> {
    const out = new Map<string, WorkerLinkRow>();
    if (anaCareIds.length === 0) return out;

    const res = await this.pool.query<WorkerLinkRowSql>(
      `SELECT ana_care_id, id, first_name_encrypted, last_name_encrypted
         FROM workers
        WHERE ana_care_id = ANY($1::text[]) AND merged_into_id IS NULL`,
      [anaCareIds as string[]],
    );
    for (const row of res.rows) {
      out.set(row.ana_care_id, {
        workerId: row.id,
        firstNameEncrypted: row.first_name_encrypted,
        lastNameEncrypted: row.last_name_encrypted,
      });
    }
    return out;
  }
}
