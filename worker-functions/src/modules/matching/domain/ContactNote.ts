/**
 * Domain types for WJA contact notes.
 *
 * Log append-only de notas manuais de contato por operadora,
 * escopadas ao par candidato×vaga (WJA).
 */

export interface ContactNote {
  id: string;
  workerJobApplicationId: string;
  noteText: string;
  createdByAdminId: string;
  createdByAdminName: string | null;
  createdByAdminEmail: string | null;
  createdAt: string; // ISO 8601
}

export interface CreateContactNoteInput {
  workerJobApplicationId: string;
  noteText: string;
  createdByAdminId: string;
  createdByAdminName: string | null;
  createdByAdminEmail: string | null;
}

/**
 * Metadados mínimos de uma nota usados pelos guards de exclusão
 * (dono + janela de 2h). Evita carregar a nota inteira só pra checar permissão.
 */
export interface ContactNoteOwnership {
  id: string;
  workerJobApplicationId: string;
  createdByAdminId: string;
  createdAt: string; // ISO 8601
}
