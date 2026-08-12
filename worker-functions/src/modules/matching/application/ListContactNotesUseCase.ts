import { ContactNoteRepository } from '../infrastructure/ContactNoteRepository';
import {
  canDeleteContactNote,
  ContactNoteView,
} from '../domain/contactNoteDeletion';

export interface ListContactNotesParams {
  vacancyId: string;
  workerId: string;
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
 * Lista as notas de contato do par (worker_id, job_posting_id) — migration 235,
 * validando pertencimento à vacante (WJA real ou tentativa bloqueada).
 * Retorna not_found se o par não pertencer à vacante informada.
 * Ordem: created_at DESC (mais recente primeiro).
 */
export class ListContactNotesUseCase {
  private repo: ContactNoteRepository;

  constructor() {
    this.repo = new ContactNoteRepository();
  }

  async execute(params: ListContactNotesParams): Promise<ListContactNotesResult> {
    const belongs = await this.repo.validateCandidateVacancyPair(params.workerId, params.vacancyId);
    if (!belongs) {
      return {
        ok: false,
        error: {
          kind: 'not_found',
          message: `Worker ${params.workerId} não pertence à vacante ${params.vacancyId}`,
        },
      };
    }

    const notes = await this.repo.findByWorkerAndVacancy(params.workerId, params.vacancyId);
    const now = Date.now();
    const view: ContactNoteView[] = notes.map((note) => ({
      ...note,
      canDelete: canDeleteContactNote(note, params.requesterAdminId, now),
    }));
    return { ok: true, notes: view };
  }
}
