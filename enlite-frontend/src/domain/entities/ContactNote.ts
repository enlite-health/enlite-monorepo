export interface ContactNote {
  id: string;
  workerJobApplicationId: string;
  noteText: string;
  createdByAdminId: string;
  createdByAdminName: string | null;
  createdByAdminEmail: string | null;
  createdAt: string; // ISO
  /** Computado pelo backend: o operador atual é o autor E está dentro de 2h. */
  canDelete: boolean;
}

export interface CreateContactNotePayload {
  noteText: string;
}
