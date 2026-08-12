import type { Pool } from 'pg';
import {
  applyCaseMemoryPatch,
  normalizeCaseMemory,
  type CaseMemory,
  type CaseMemoryPatch,
} from '../domain/CaseMemory';

export interface CaseMemoryRecord {
  caseMemory: CaseMemory;
  updatedAt: string;
}

/**
 * Persistência do dossiê da Luz (Camada A) — 1 linha JSONB por worker em
 * `worker_case_memory`. O merge/FIFO/caps vive no domínio (applyCaseMemoryPatch);
 * aqui é só o I/O. `put` é read-modify-write (2 queries) — aceitável: uma
 * conversa por worker de cada vez (cooldown no triage), sem escrita concorrente.
 */
export class CaseMemoryRepository {
  constructor(private readonly db: Pool) {}

  async get(workerId: string): Promise<CaseMemoryRecord | null> {
    const { rows } = await this.db.query<{ data: unknown; updated_at: Date }>(
      `SELECT data, updated_at FROM worker_case_memory WHERE worker_id = $1`,
      [workerId],
    );
    if (rows.length === 0) return null;
    return {
      caseMemory: normalizeCaseMemory(rows[0].data),
      updatedAt: rows[0].updated_at.toISOString(),
    };
  }

  async put(
    workerId: string,
    patch: CaseMemoryPatch,
  ): Promise<CaseMemoryRecord> {
    const existing = await this.get(workerId);
    const next = applyCaseMemoryPatch(existing?.caseMemory ?? {}, patch);
    const { rows } = await this.db.query<{ updated_at: Date }>(
      `INSERT INTO worker_case_memory (worker_id, data, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (worker_id)
       DO UPDATE SET data = $2::jsonb, updated_at = now()
       RETURNING updated_at`,
      [workerId, JSON.stringify(next)],
    );
    return { caseMemory: next, updatedAt: rows[0].updated_at.toISOString() };
  }
}
