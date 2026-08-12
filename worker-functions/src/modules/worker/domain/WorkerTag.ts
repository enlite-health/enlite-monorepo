/**
 * WorkerTag — domain types for the worker tag feature.
 *
 * worker_tag_catalog : catálogo central de tags (gerenciado por admin).
 * WorkerTagAssignment: associação entre worker e tag.
 */

export interface WorkerTag {
  id: string;
  name: string;
  /** Cor hex no formato #RRGGBB. */
  color: string;
  description?: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkerTagAssignment {
  workerId: string;
  tagId: string;
  assignedBy: string;
  assignedAt: Date;
}

export interface CreateWorkerTagDTO {
  name: string;
  color: string;
  description?: string;
  createdBy: string;
}

export interface UpdateWorkerTagDTO {
  name?: string;
  color?: string;
  description?: string;
}

/** Shape devolvido no worker detail e na listagem de catálogo. */
export interface WorkerTagSummary {
  id: string;
  name: string;
  color: string;
  description?: string;
}
