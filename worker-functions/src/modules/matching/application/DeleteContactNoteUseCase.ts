import { ContactNoteRepository } from '../infrastructure/ContactNoteRepository';
import { CONTACT_NOTE_DELETE_WINDOW_MS } from '../domain/contactNoteDeletion';

export interface DeleteContactNoteParams {
  vacancyId: string;
  wjaId: string;
  noteId: string;
  requesterAdminId: string;
}

export type DeleteContactNoteError =
  | { kind: 'not_found'; message: string }
  | { kind: 'forbidden'; reason: 'not_owner' | 'window_expired'; message: string };

export type DeleteContactNoteResult =
  | { ok: true }
  | { ok: false; error: DeleteContactNoteError };

/**
 * DeleteContactNoteUseCase
 *
 * Exclui uma nota de contato. Regras (autoritativas no servidor):
 *  - Só o AUTOR da nota pode excluí-la (created_by_admin_id === requesterAdminId).
 *  - Só dentro de 2h da criação. Depois disso, é permanente.
 *  - A nota precisa pertencer à WJA, e a WJA à vacante (guards de escopo).
 */
export class DeleteContactNoteUseCase {
  private repo: ContactNoteRepository;

  constructor() {
    this.repo = new ContactNoteRepository();
  }

  async execute(params: DeleteContactNoteParams): Promise<DeleteContactNoteResult> {
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

    const note = await this.repo.findOwnershipById(params.noteId);
    if (!note || note.workerJobApplicationId !== params.wjaId) {
      return {
        ok: false,
        error: { kind: 'not_found', message: `Nota ${params.noteId} não encontrada` },
      };
    }

    if (note.createdByAdminId !== params.requesterAdminId) {
      return {
        ok: false,
        error: {
          kind: 'forbidden',
          reason: 'not_owner',
          message: 'Só o autor da nota pode excluí-la',
        },
      };
    }

    const ageMs = Date.now() - new Date(note.createdAt).getTime();
    if (ageMs >= CONTACT_NOTE_DELETE_WINDOW_MS) {
      return {
        ok: false,
        error: {
          kind: 'forbidden',
          reason: 'window_expired',
          message: 'O prazo de 2h para excluir esta nota expirou',
        },
      };
    }

    await this.repo.deleteById(params.noteId);
    return { ok: true };
  }
}
