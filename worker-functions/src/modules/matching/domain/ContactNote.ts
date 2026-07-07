/**
 * Domain types for worker contact notes.
 *
 * Log append-only de notas manuais de contato por operadora, escopadas
 * SOMENTE À VAGA (job_posting_id) — migration 236.
 *
 * Migration 235 chaveava por par (worker_id, job_posting_id) — uma thread por
 * candidato. Produto decidiu que a thread é ÚNICA POR VAGA: a mesma
 * conversa aparece idêntica em TODOS os cards da vaga (bloqueado ou não,
 * qualquer coluna, qualquer candidato). worker_id e worker_job_application_id
 * viraram redundantes e foram removidos (a feature tinha <1 dia em prod, sem
 * consumidor externo dessas colunas). Ver ContactNoteRepository.
 */

export interface ContactNote {
  id: string;
  jobPostingId: string;
  noteText: string;
  createdByAdminId: string;
  createdByAdminName: string | null;
  createdByAdminEmail: string | null;
  createdAt: string; // ISO 8601
}

export interface CreateContactNoteInput {
  jobPostingId: string;
  noteText: string;
  createdByAdminId: string;
  createdByAdminName: string | null;
  createdByAdminEmail: string | null;
}

/**
 * Metadados mínimos de uma nota usados pelos guards de exclusão
 * (dono + janela de 2h + pertencimento à vaga). Evita carregar a nota
 * inteira só pra checar permissão.
 */
export interface ContactNoteOwnership {
  id: string;
  jobPostingId: string;
  createdByAdminId: string;
  createdAt: string; // ISO 8601
}
