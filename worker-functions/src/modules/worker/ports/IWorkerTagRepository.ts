/**
 * IWorkerTagRepository — port (interface) for worker tag persistence.
 *
 * All catalog reads filter deleted_at IS NULL unless stated otherwise.
 */

import { WorkerTag, WorkerTagSummary, CreateWorkerTagDTO, UpdateWorkerTagDTO } from '../domain/WorkerTag';

export interface IWorkerTagRepository {
  /** Lista todos os tags ativos do catálogo (deleted_at IS NULL). */
  listCatalog(): Promise<WorkerTag[]>;

  /** Cria uma nova tag no catálogo. */
  createTag(input: CreateWorkerTagDTO): Promise<WorkerTag>;

  /** Atualiza nome, cor e/ou descrição de uma tag existente. */
  updateTag(id: string, input: UpdateWorkerTagDTO): Promise<WorkerTag | null>;

  /** Soft-delete: define deleted_at = NOW(). */
  softDeleteTag(id: string): Promise<boolean>;

  /** Busca tag por ID, incluindo soft-deleted (para validações internas). */
  findTagById(id: string): Promise<WorkerTag | null>;

  /**
   * Associa tag a worker. Idempotente via ON CONFLICT DO NOTHING.
   * Retorna false se a tag não existir ou estiver soft-deleted.
   */
  assignTagToWorker(workerId: string, tagId: string, assignedBy: string): Promise<boolean>;

  /** Remove associação worker ↔ tag. Retorna true se removeu alguma linha. */
  removeTagFromWorker(workerId: string, tagId: string): Promise<boolean>;

  /**
   * Lista tags de um worker (JOIN worker_tag_catalog, deleted_at IS NULL),
   * ordenadas por name ASC.
   */
  listTagsForWorker(workerId: string): Promise<WorkerTagSummary[]>;
}
