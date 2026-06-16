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
  createdByAdminEmail: string | null;
  createdAt: string; // ISO 8601
}

export interface CreateContactNoteInput {
  workerJobApplicationId: string;
  noteText: string;
  createdByAdminId: string;
  createdByAdminEmail: string | null;
}
