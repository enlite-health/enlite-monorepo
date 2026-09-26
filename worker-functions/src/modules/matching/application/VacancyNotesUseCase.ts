import { VacancyNoteRepository } from '../infrastructure/VacancyNoteRepository';
import { VacancyNote, createVacancyNoteSchema } from '../domain/VacancyNote';

export type VacancyNotesError =
  | { kind: 'validation'; message: string }
  | { kind: 'not_found'; message: string };

export type ListVacancyNotesResult =
  | { ok: true; notes: VacancyNote[] }
  | { ok: false; error: VacancyNotesError };

export type CreateVacancyNoteResult =
  | { ok: true; note: VacancyNote }
  | { ok: false; error: VacancyNotesError };

/**
 * VacancyNotesUseCase
 *
 * Anotação tipo CRM por vacante (DX-3.3, #DEC-31). `list` e `create`
 * recusam vaga inexistente/apagada com `not_found`; `create` valida o
 * corpo com o schema canônico de `domain/VacancyNote.ts` antes de
 * verificar a vaga.
 */
export class VacancyNotesUseCase {
  private repo: VacancyNoteRepository;

  constructor(repo?: VacancyNoteRepository) {
    this.repo = repo ?? new VacancyNoteRepository();
  }

  async list(vacancyId: string): Promise<ListVacancyNotesResult> {
    const exists = await this.repo.vacancyExists(vacancyId);
    if (!exists) {
      return { ok: false, error: { kind: 'not_found', message: `Vacancy ${vacancyId} not found` } };
    }
    const notes = await this.repo.listByVacancy(vacancyId);
    return { ok: true, notes };
  }

  async create(vacancyId: string, raw: unknown, createdBy: string): Promise<CreateVacancyNoteResult> {
    const parsed = createVacancyNoteSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        error: { kind: 'validation', message: parsed.error.errors[0]?.message ?? 'invalid payload' },
      };
    }

    const exists = await this.repo.vacancyExists(vacancyId);
    if (!exists) {
      return { ok: false, error: { kind: 'not_found', message: `Vacancy ${vacancyId} not found` } };
    }

    const note = await this.repo.insert({
      jobPostingId: vacancyId,
      occurredAt: parsed.data.occurredAt,
      category: parsed.data.category,
      contact: parsed.data.contact,
      body: parsed.data.body,
      createdBy,
    });

    return { ok: true, note };
  }
}
