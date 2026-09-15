import { z } from 'zod';

/**
 * Validadores de foto/documento/consentimento de imagem (spec 018, PR-4;
 * `contracts/patient-header-and-photo.md`). `.strict()` em todo corpo — campo a mais = 400.
 */

export const patientIdParamsSchema = z.object({ id: z.string().uuid() });
export const patientDocumentIdParamsSchema = z.object({ id: z.string().uuid(), documentId: z.string().uuid() });
export const patientConsentIdParamsSchema = z.object({ id: z.string().uuid(), cid: z.string().uuid() });

const REVOCATION_CHANNELS = ['WRITTEN', 'EMAIL', 'IN_PERSON', 'PHONE'] as const;
const REPRESENTATION_BASIS = ['PARENTAL_RESPONSIBILITY', 'GUARDIAN_DESIGNATION'] as const;
const DOCUMENT_TYPES = ['image_consent', 'image_consent_revocation'] as const;

/** `POST /patients/:id/image-consents` — `documentId` OPCIONAL (decisão 14/09, D335). */
export const registerImageConsentSchema = z
  .object({
    consenterKind: z.enum(['PATIENT', 'REPRESENTATIVE']),
    responsibleId: z.string().uuid().nullable().optional(),
    documentId: z.string().uuid().nullable().optional(),
    textVersion: z.string().trim().min(1),
    consentedAt: z.string().datetime({ offset: true }).or(z.string().datetime()),
    representationBasis: z.enum(REPRESENTATION_BASIS).nullable().optional(),
    representationVerifiedBy: z.string().trim().min(1).nullable().optional(),
  })
  .strict();

/** `POST /patients/:id/image-consents/:cid/revoke` — `revocationDocumentId` OPCIONAL. */
export const revokeImageConsentSchema = z
  .object({
    revocationDocumentId: z.string().uuid().nullable().optional(),
    revocationChannel: z.enum(REVOCATION_CHANNELS),
  })
  .strict();

/** `documentType` do multipart — vem em `req.body.documentType` (campo de texto ao lado do `file`). */
export const uploadDocumentBodySchema = z
  .object({
    documentType: z.enum(DOCUMENT_TYPES),
  })
  .strict();
