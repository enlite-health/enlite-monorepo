import { ContactNoteRepository } from '../infrastructure/ContactNoteRepository';
import {
  canDeleteContactNote,
  ContactNoteView,
} from '../domain/contactNoteDeletion';

export interface ListContactNotesParams {
  vacancyId: string;
  /** Operador que está pedindo a lista — define `canDelete` por nota. */
  requesterAdminId: string;
}

export type ListContactNotesError =
  | { kind: 'not_found'; message: string };

export type ListContactNotesResult =
  | { ok: true; notes: ContactNoteView[] }
  | { ok: false; error: ListContactNotesError };

/**
 * ListContactNotesUseCase
 *
 * Lista as notas de contato da VAGA (job_posting_id) — migration 236. A
 * mesma thread é retornada para qualquer card/candidato dessa vaga.
 * Retorna not_found se a vaga não existir. Ordem: created_at DESC (mais
 * recente primeiro).
 */
export class ListContactNotesUseCase {
  private repo: ContactNoteRepository;

  constructor() {
    this.repo = new ContactNoteRepository();
  }

  async execute(params: ListContactNotesParams): Promise<ListContactNotesResult> {
    const vacancyExists = await this.repo.validateVacancyExists(params.vacancyId);
    if (!vacancyExists) {
      return {
        ok: false,
        error: {
          kind: 'not_found',
          message: `Vacante ${params.vacancyId} não encontrada`,
        },
      };
    }

    const notes = await this.repo.findByVacancy(params.vacancyId);
    const now = Date.now();
    const view: ContactNoteView[] = notes.map((note) => ({
      ...note,
      canDelete: canDeleteContactNote(note, params.requesterAdminId, now),
    }));
    return { ok: true, notes: view };
  }
}
