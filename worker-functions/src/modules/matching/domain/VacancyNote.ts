/**
 * Domain types for vacancy (job posting) CRM-style notes.
 *
 * Anotação manual por vacante — "o que o time fez com a vaga" (divulgação,
 * contato, outro), #DEC-31 (cadeia-paciente-vacante-itinerario, Fase 3).
 * Categorias = CHECK da migration 474 (`job_posting_notes`); repositório e
 * use case importam a lista daqui, nunca a repetem.
 */
import { z } from 'zod';

export const VACANCY_NOTE_CATEGORIES = ['DIVULGACAO', 'CONTATO', 'OUTRO'] as const; // = CHECK da 474
export type VacancyNoteCategory = (typeof VACANCY_NOTE_CATEGORIES)[number];

export interface VacancyNote {
  id: string;
  jobPostingId: string;
  occurredAt: string;
  category: VacancyNoteCategory;
  contact: string;
  body: string;
  createdBy: string;
  authorEmail: string | null;
  createdAt: string;
}

export const FUTURE_SKEW_MS = 5 * 60 * 1000;

export const createVacancyNoteSchema = z.object({
  occurredAt: z
    .string()
    .datetime({ offset: true })
    .refine((s) => Date.parse(s) <= Date.now() + FUTURE_SKEW_MS, 'occurredAt no futuro'),
  category: z.enum(VACANCY_NOTE_CATEGORIES),
  contact: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(2000),
});

export type CreateVacancyNoteInput = z.infer<typeof createVacancyNoteSchema>;
