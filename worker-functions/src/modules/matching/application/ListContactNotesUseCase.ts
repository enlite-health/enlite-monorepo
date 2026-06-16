import { ContactNoteRepository } from '../infrastructure/ContactNoteRepository';
import { ContactNote } from '../domain/ContactNote';

export interface ListContactNotesParams {
  vacancyId: string;
  wjaId: string;
}

export type ListContactNotesError =
  | { kind: 'not_found'; message: string };

export type ListContactNotesResult =
  | { ok: true; notes: ContactNote[] }
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
    return { ok: true, notes };
  }
}
