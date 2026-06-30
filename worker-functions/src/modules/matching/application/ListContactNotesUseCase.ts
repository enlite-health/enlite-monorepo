import { ContactNoteRepository } from '../infrastructure/ContactNoteRepository';
import {
  canDeleteContactNote,
  ContactNoteView,
} from '../domain/contactNoteDeletion';

export interface ListContactNotesParams {
  vacancyId: string;
  wjaId: string;
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
 * Lista as notas de contato de uma WJA, validando pertencimento à vacante.
 * Retorna not_found se o wjaId não pertencer à vacante informada.
 * Ordem: created_at DESC (mais recente primeiro).
 */
export class ListContactNotesUseCase {
  private repo: ContactNoteRepository;

  constructor() {
    this.repo = new ContactNoteRepository();
  }

  async execute(params: ListContactNotesParams): Promise<ListContactNotesResult> {
    const belongs = await this.repo.wjaBelongsToVacancy(params.wjaId, params.vacancyId);
    if (!belongs) {
      return {
        ok: false,
        error: {
          kind: 'not_found',
          message: `WJA ${params.wjaId} não pertence à vacante ${params.vacancyId}`,
        },
      };
    }

    const notes = await this.repo.findByWJA(params.wjaId);
    const now = Date.now();
    const view: ContactNoteView[] = notes.map((note) => ({
      ...note,
      canDelete: canDeleteContactNote(note, params.requesterAdminId, now),
    }));
    return { ok: true, notes: view };
  }
}
