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
 * Valida e persiste uma nota de contato escopada SOMENTE À VAGA
 * (job_posting_id) — migration 236. A thread é única por vaga: aparece
 * idêntica em todos os cards/candidatos daquela vaga. Verifica que a vaga
 * existe antes de inserir; retorna not_found caso contrário.
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

    // Snapshot do autor a partir do cadastro de staff (users.display_name vem do
    // displayName do Firebase). O nome/email do token nem sempre chega no req.user,
    // então a fonte canônica aqui é a tabela users. Fallback pro email do token.
    const admin = await this.adminRepo.findByFirebaseUid(params.adminId);
    const createdByAdminName = admin?.displayName ?? null;
    const createdByAdminEmail = admin?.email ?? params.adminEmail ?? null;

    const note = await this.repo.insert({
      jobPostingId: params.vacancyId,
      noteText: parsed.data.noteText,
      createdByAdminId: params.adminId,
      createdByAdminName,
      createdByAdminEmail,
    });

    return { ok: true, note };
  }
}
