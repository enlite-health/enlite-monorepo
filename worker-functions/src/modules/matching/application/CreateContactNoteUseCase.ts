import { z } from 'zod';
import { ContactNoteRepository } from '../infrastructure/ContactNoteRepository';
import { ContactNote } from '../domain/ContactNote';

const createContactNoteSchema = z.object({
  noteText: z
    .string()
    .trim()
    .min(1, 'noteText não pode ser vazio')
    .max(240, 'noteText não pode exceder 240 caracteres'),
});

export interface CreateContactNoteParams {
  vacancyId: string;
  wjaId: string;
  noteText: string;
  adminId: string;
  adminEmail: string | null;
}

export type CreateContactNoteError =
  | { kind: 'validation'; message: string }
  | { kind: 'not_found'; message: string };

export type CreateContactNoteResult =
  | { ok: true; note: ContactNote }
  | { ok: false; error: CreateContactNoteError };

/**
 * CreateContactNoteUseCase
 *
 * Valida e persiste uma nota de contato escopada ao par WJA×vacante.
 * Verifica pertencimento antes de inserir — retorna not_found se o wjaId
 * não pertencer à vacante informada.
 */
export class CreateContactNoteUseCase {
  private repo: ContactNoteRepository;

  constructor() {
    this.repo = new ContactNoteRepository();
  }

  async execute(params: CreateContactNoteParams): Promise<CreateContactNoteResult> {
    const parsed = createContactNoteSchema.safeParse({ noteText: params.noteText });
    if (!parsed.success) {
      return {
        ok: false,
        error: { kind: 'validation', message: parsed.error.errors[0].message },
      };
    }

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

    const note = await this.repo.insert({
      workerJobApplicationId: params.wjaId,
      noteText: parsed.data.noteText,
      createdByAdminId: params.adminId,
      createdByAdminEmail: params.adminEmail,
    });

    return { ok: true, note };
  }
}
