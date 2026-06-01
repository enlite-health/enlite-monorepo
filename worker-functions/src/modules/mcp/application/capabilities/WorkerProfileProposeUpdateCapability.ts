/**
 * WorkerProfileProposeUpdateCapability
 *
 * Fase 1 do propose/confirm da Luz. Valida os campos server-side (Zod strict +
 * regra Latam por documentType), NÃO grava — estaciona o change e devolve um
 * handle opaco + resumo pra Luz pedir confirmação ao worker.
 *
 * Whitelist v1: nome, data de nascimento, documento (DNI/CPF/...), endereço.
 * email/phone NÃO entram aqui — são campos de login/identificador → handover.
 */

import { z } from 'zod';
import type { ProposeWorkerProfileUpdateUseCase } from '../../../worker/application/ProposeWorkerProfileUpdateUseCase';

// ── Validação de documento por tipo ───────────────────────────────────────────
// document_type canônico no schema: DNI, PASSPORT, CEDULA, LE_LC, CPF (migration 139).
// Enlite opera em AR + BR (migration 069: country CHECK IN ('AR','BR')):
//   - AR: DNI (atual, 7–8 dígitos), LE_LC (libretas antigas, 6–8 dígitos)
//   - BR: CPF
//   - PASSPORT: estrangeiros (alfanumérico)
//   - CEDULA: mantido por estar no enum canônico; regra numérica permissiva.
const DocumentTypeEnum = z.enum(['DNI', 'PASSPORT', 'CEDULA', 'LE_LC', 'CPF']);

const DOCUMENT_NUMBER_RULES: Record<string, RegExp> = {
  DNI: /^\d{7,8}$/, // Argentina: 7–8 dígitos
  LE_LC: /^\d{6,8}$/, // libreta AR antiga
  CPF: /^[0-9.\-]{11,14}$/, // Brasil (mesma regra do worker.profile.update)
  PASSPORT: /^[A-Za-z0-9]{5,15}$/, // alfanumérico
  CEDULA: /^\d{5,9}$/, // permissivo (não-AR/BR; presente no enum canônico)
};

const AddressSchema = z
  .object({
    street: z.string().min(1).max(200).optional(),
    number: z.string().max(20).optional(),
    complement: z.string().max(100).optional(),
    neighborhood: z.string().max(100).optional(),
    city: z.string().max(100).optional(),
    zipCode: z.string().max(20).optional(),
    state: z.string().max(50).optional(),
  })
  .strict();

const FieldsSchema = z
  .object({
    firstName: z.string().min(1).max(100).optional(),
    lastName: z.string().min(1).max(100).optional(),
    birthDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(), // ISO YYYY-MM-DD
    documentType: DocumentTypeEnum.optional(),
    documentNumber: z.string().min(4).max(30).optional(),
    address: AddressSchema.optional(),
  })
  .strict() // rejeita email, phone, status, etc.
  .superRefine((val, ctx) => {
    // documento: número exige tipo, e o formato é validado conforme o tipo.
    if (val.documentNumber !== undefined && val.documentType === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['documentType'],
        message: 'documentType is required when documentNumber is provided',
      });
      return;
    }
    if (val.documentNumber !== undefined && val.documentType !== undefined) {
      const rule = DOCUMENT_NUMBER_RULES[val.documentType];
      if (rule && !rule.test(val.documentNumber)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['documentNumber'],
          message: `documentNumber does not match the expected format for ${val.documentType}`,
        });
      }
    }
  });

const ArgsSchema = z
  .object({
    workerId: z.string().uuid(),
    fields: FieldsSchema,
    conversationRef: z.string().max(120).optional(),
  })
  .strict();

export type WorkerProfileProposeUpdateArgs = z.infer<typeof ArgsSchema>;

// ── Capability ────────────────────────────────────────────────────────────────

export class WorkerProfileProposeUpdateCapability {
  static readonly NAME = 'worker.profile.proposeUpdate';
  static readonly DESCRIPTION =
    'Propose (stage) a worker profile update for explicit confirmation. Validates fields ' +
    'server-side and returns an opaque handle + a summary to show the worker ("update X to Y, confirm?"). ' +
    'Does NOT write. Editable: name, birthDate, document (DNI/CPF/CEDULA/LE_LC/PASSPORT), address. ' +
    'email and phone are NEVER editable here — route those to a human handover.';
  static readonly INPUT_SHAPE = {
    workerId: z.string().uuid(),
    fields: FieldsSchema,
    conversationRef: z.string().max(120).optional(),
  };

  constructor(private readonly useCase: ProposeWorkerProfileUpdateUseCase) {}

  async execute(args: unknown): Promise<{
    handle: string;
    expiresAt: string;
    summary: { field: string; newValue: string }[];
  }> {
    const parsed = ArgsSchema.parse(args);
    return this.useCase.execute({
      workerId: parsed.workerId,
      fields: parsed.fields,
      conversationRef: parsed.conversationRef,
    });
  }
}
