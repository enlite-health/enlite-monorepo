import { z } from 'zod';
import type { Profession } from '../../../worker/domain/enums/Profession';

/**
 * publicLeadSchema — validates the body of POST /api/public/v1/leads.
 *
 * Public B2C intake (D4): a patient (or their family) fills 4 minimal fields on
 * the /admision page, no login. Strict validation + rate-limit protect the
 * unauthenticated surface.
 *
 * `serviceType` accepts EITHER the three front-end service slugs
 * (cuidadores | acompanantes_terapeuticos | psicologos) OR a raw Profession
 * value, and is mapped to a canonical Profession in the use case.
 */

/** The service options offered on the public form (accent-free, stable slugs). */
export const LEAD_SERVICE_SLUGS = [
  'cuidadores',
  'acompanantes_terapeuticos',
  'psicologos',
] as const;
export type LeadServiceSlug = (typeof LEAD_SERVICE_SLUGS)[number];

/** Accepted request values for serviceType: the 3 slugs + the raw Profession enum. */
export const LEAD_SERVICE_VALUES = [
  ...LEAD_SERVICE_SLUGS,
  'CAREGIVER',
  'AT',
  'PSYCHOLOGIST',
] as const;

/** Maps any accepted serviceType request value to its canonical Profession. */
export const LEAD_SERVICE_TO_PROFESSION: Record<
  (typeof LEAD_SERVICE_VALUES)[number],
  Profession
> = {
  cuidadores: 'CAREGIVER',
  acompanantes_terapeuticos: 'AT',
  psicologos: 'PSYCHOLOGIST',
  CAREGIVER: 'CAREGIVER',
  AT: 'AT',
  PSYCHOLOGIST: 'PSYCHOLOGIST',
};

export const publicLeadSchema = z
  .object({
    serviceType: z.enum(LEAD_SERVICE_VALUES),
    requesterType: z.enum(['patient', 'responsible']),
    email: z.string().trim().toLowerCase().email(),
    phone: z.string().trim().min(1, { message: 'phone is required' }),
    name: z.string().trim().min(1).optional(),
  })
  .strict();

export type PublicLeadBody = z.infer<typeof publicLeadSchema>;
