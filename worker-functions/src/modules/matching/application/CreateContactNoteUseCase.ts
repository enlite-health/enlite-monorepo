import { z } from 'zod';
import { ContactNoteRepository } from '../infrastructure/ContactNoteRepository';
import { ContactNote } from '../domain/ContactNote';
import { AdminRepository } from '@modules/identity';

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
  private adminRepo: AdminRepository;

  constructor() {
    this.repo = new ContactNoteRepository();
    this.adminRepo = new AdminRepository();
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

    // Snapshot do autor a partir do cadastro de staff (users.display_name vem do
    // displayName do Firebase). O nome/email do token nem sempre chega no req.user,
    // então a fonte canônica aqui é a tabela users. Fallback pro email do token.
    const admin = await this.adminRepo.findByFirebaseUid(params.adminId);
    const createdByAdminName = admin?.displayName ?? null;
    const createdByAdminEmail = admin?.email ?? params.adminEmail ?? null;

    const note = await this.repo.insert({
      workerJobApplicationId: params.wjaId,
      noteText: parsed.data.noteText,
      createdByAdminId: params.adminId,
      createdByAdminName,
      createdByAdminEmail,
    });

    return { ok: true, note };
  }
}
