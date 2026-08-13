/**
 * Domain types for worker contact notes.
 *
 * Log append-only de notas manuais de contato por operadora, escopadas ao
 * par estável candidato×vaga (worker_id, job_posting_id) — migration 235.
 *
 * Esse par sobrevive à promoção BLOQUEADO→INICIADO (o worker_job_application_id
 * só passa a existir depois de promovido), então as notas seguem o candidato
 * sem precisar de copy-on-promote. Ver ContactNoteRepository.
 */

export interface ContactNote {
  id: string;
  workerId: string;
  jobPostingId: string;
  /** Legado (migration 204). Null para notas escritas antes de existir WJA (card BLOQUEADO). */
  workerJobApplicationId: string | null;
  noteText: string;
  createdByAdminId: string;
  createdByAdminName: string | null;
  createdByAdminEmail: string | null;
  createdAt: string; // ISO 8601
}

export interface CreateContactNoteInput {
  workerId: string;
  jobPostingId: string;
  noteText: string;
  createdByAdminId: string;
  createdByAdminName: string | null;
  createdByAdminEmail: string | null;
}

/**
 * Metadados mínimos de uma nota usados pelos guards de exclusão
 * (dono + janela de 2h + pertencimento ao par). Evita carregar a nota
 * inteira só pra checar permissão.
 */
export interface ContactNoteOwnership {
  id: string;
  workerId: string;
  jobPostingId: string;
  createdByAdminId: string;
  createdAt: string; // ISO 8601
}
