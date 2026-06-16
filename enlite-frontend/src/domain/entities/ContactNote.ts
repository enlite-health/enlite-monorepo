export interface ContactNote {
  id: string;
  workerJobApplicationId: string;
  noteText: string;
  createdByAdminId: string;
  createdByAdminEmail: string | null;
  createdAt: string; // ISO
}

export interface CreateContactNotePayload {
  noteText: string;
}
