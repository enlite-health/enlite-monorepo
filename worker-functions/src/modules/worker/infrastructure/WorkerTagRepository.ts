/**
 * WorkerTagRepository — Postgres adapter for worker tag persistence.
 *
 * Follows the same Pool/DatabaseConnection pattern used across the worker module.
 */

import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { IWorkerTagRepository } from '../ports/IWorkerTagRepository';
import { WorkerTag, WorkerTagSummary, CreateWorkerTagDTO, UpdateWorkerTagDTO } from '../domain/WorkerTag';

function rowToTag(row: Record<string, unknown>): WorkerTag {
  return {
    id: row.id as string,
    name: row.name as string,
    color: row.color as string,
    description: (row.description as string | null) ?? undefined,
    createdBy: row.created_by as string,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

export class WorkerTagRepository implements IWorkerTagRepository {
  private readonly pool: Pool;

  constructor() {
    this.pool = DatabaseConnection.getInstance().getPool();
  }

  async listCatalog(): Promise<WorkerTag[]> {
    const result = await this.pool.query(
      `SELECT id, name, color, description, created_by, created_at, updated_at
         FROM worker_tag_catalog
        WHERE deleted_at IS NULL
        ORDER BY name ASC`,
    );
    return result.rows.map(rowToTag);
  }

  async createTag(input: CreateWorkerTagDTO): Promise<WorkerTag> {
    const result = await this.pool.query(
      `INSERT INTO worker_tag_catalog (name, color, description, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, color, description, created_by, created_at, updated_at`,
      [input.name, input.color, input.description ?? null, input.createdBy],
    );
    return rowToTag(result.rows[0]);
  }

  async updateTag(id: string, input: UpdateWorkerTagDTO): Promise<WorkerTag | null> {
    const sets: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [];
    let idx = 1;

    if (input.name !== undefined) { sets.push(`name = $${idx++}`); values.push(input.name); }
    if (input.color !== undefined) { sets.push(`color = $${idx++}`); values.push(input.color); }
    if (input.description !== undefined) { sets.push(`description = $${idx++}`); values.push(input.description); }

    values.push(id);

    const result = await this.pool.query(
      `UPDATE worker_tag_catalog
          SET ${sets.join(', ')}
        WHERE id = $${idx} AND deleted_at IS NULL
        RETURNING id, name, color, description, created_by, created_at, updated_at`,
      values,
    );

    return result.rows.length > 0 ? rowToTag(result.rows[0]) : null;
  }

  async softDeleteTag(id: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE worker_tag_catalog
          SET deleted_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async findTagById(id: string): Promise<WorkerTag | null> {
    const result = await this.pool.query(
      `SELECT id, name, color, description, created_by, created_at, updated_at
         FROM worker_tag_catalog
        WHERE id = $1`,
      [id],
    );
    return result.rows.length > 0 ? rowToTag(result.rows[0]) : null;
  }

  async assignTagToWorker(workerId: string, tagId: string, assignedBy: string): Promise<boolean> {
    // First verify tag exists and is not deleted
    const tag = await this.findTagById(tagId);
    if (!tag) return false;

    const result = await this.pool.query(
      `SELECT deleted_at FROM worker_tag_catalog WHERE id = $1`,
      [tagId],
    );
    if (result.rows.length === 0 || result.rows[0].deleted_at !== null) return false;

    await this.pool.query(
      `INSERT INTO worker_tags (worker_id, tag_id, assigned_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (worker_id, tag_id) DO NOTHING`,
      [workerId, tagId, assignedBy],
    );
    return true;
  }

  async removeTagFromWorker(workerId: string, tagId: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM worker_tags WHERE worker_id = $1 AND tag_id = $2`,
      [workerId, tagId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async listTagsForWorker(workerId: string): Promise<WorkerTagSummary[]> {
    const result = await this.pool.query(
      `SELECT c.id, c.name, c.color, c.description
         FROM worker_tags wt
         JOIN worker_tag_catalog c ON c.id = wt.tag_id
        WHERE wt.worker_id = $1
          AND c.deleted_at IS NULL
        ORDER BY c.name ASC`,
      [workerId],
    );
    return result.rows.map((row: Record<string, unknown>) => ({
      id: row.id as string,
      name: row.name as string,
      color: row.color as string,
      description: (row.description as string | null) ?? undefined,
    }));
  }
}
