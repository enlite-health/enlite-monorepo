export const VACANCY_NOTE_CATEGORIES = ['DIVULGACAO', 'CONTATO', 'OUTRO'] as const;

export type VacancyNoteCategory = (typeof VACANCY_NOTE_CATEGORIES)[number];

export interface VacancyNote {
  id: string;
  jobPostingId: string;
  occurredAt: string; // ISO
  category: VacancyNoteCategory;
  contact: string;
  body: string;
  createdBy: string;
  authorEmail: string | null;
  createdAt: string; // ISO
}

export interface CreateVacancyNotePayload {
  occurredAt: string; // ISO
  category: VacancyNoteCategory;
  contact: string;
  body: string;
}
