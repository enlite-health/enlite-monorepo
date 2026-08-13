/**
 * WorkerProfileUpdateCapability
 *
 * MCP write capability that updates worker profile fields.
 * Only whitelisted LGPD-compliant fields are editable (sprint §5.2).
 * Zod strict mode rejects any key not in the whitelist.
 *
 * Phone, status, bank account and internal flags are NEVER editable here.
 */

import { z } from 'zod';
import type {
  UpdateWorkerProfileFieldsUseCase,
  WorkerProfilePatch,
} from '../../../worker/application/UpdateWorkerProfileFieldsUseCase';
import { PROFILE_EDIT_SOURCES } from '../../../worker/domain/profileEditSource';

// ── Schemas ──────────────────────────────────────────────────────────────────

const AddressUpdateSchema = z
  .object({
    street:       z.string().min(1).max(200).optional(),
    number:       z.string().max(20).optional(),
    complement:   z.string().max(100).optional(),
    neighborhood: z.string().max(100).optional(),
    city:         z.string().max(100).optional(),
    zipCode:      z.string().max(20).optional(),
    state:        z.string().max(50).optional(),
  })
  .strict(); // rejects unknown keys

const FieldsSchema = z
  .object({
    firstName: z.string().min(1).max(100).optional(),
    lastName:  z.string().min(1).max(100).optional(),
    email:     z.string().email().optional(),
    cpf:       z.string().regex(/^[0-9.\-]{11,14}$/).optional(),
    rg:        z.string().min(1).max(50).optional(),
    birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), // ISO date
    meiNumber: z.string().max(50).optional(),
    meiCnpj:   z.string().regex(/^[0-9.\-/]{14,18}$/).optional(),
    address:   AddressUpdateSchema.optional(),
  })
  .strict(); // rejects phone, status, bankAccount, etc.

const ArgsSchema = z.object({
  workerId: z.string().uuid(),
  fields:   FieldsSchema,
  /** Fonte da edição (rastreabilidade). Default: luz_conversation (canal MCP = Luz). */
  source:   z.enum(PROFILE_EDIT_SOURCES).optional(),
});

export type WorkerProfileUpdateArgs = z.infer<typeof ArgsSchema>;

// ── Capability ────────────────────────────────────────────────────────────────

export class WorkerProfileUpdateCapability {
  static readonly NAME = 'worker.profile.update';
  static readonly DESCRIPTION =
    'Update worker profile fields. Only whitelisted PII fields (LGPD-compliant) are editable. ' +
    'Phone, status and bank account are NEVER editable via this capability.';
  static readonly INPUT_SHAPE = {
    workerId: z.string().uuid(),
    fields:   FieldsSchema,
    source:   z.enum(PROFILE_EDIT_SOURCES).optional(),
  };

  constructor(
    private readonly updateUseCase: UpdateWorkerProfileFieldsUseCase,
  ) {}

  async execute(args: unknown): Promise<{
    updated: true;
    workerId: string;
    fieldsUpdated: string[];
  }> {
    const parsed = ArgsSchema.parse(args);
    const { workerId, fields, source } = parsed;

    // Identify which keys were explicitly provided (not undefined)
    const sentKeys = Object.keys(fields).filter(
      (k) => (fields as Record<string, unknown>)[k] !== undefined,
    );
    if (sentKeys.length === 0) {
      throw new Error('At least one field must be provided');
    }

    const patch: WorkerProfilePatch = { workerId, ...fields };
    const result = await this.updateUseCase.execute(patch, {
      source: source ?? 'luz_conversation',
      actorUid: 'luz:profile-update',
    });

    return { updated: true, workerId: result.workerId, fieldsUpdated: result.fieldsUpdated };
  }
}
