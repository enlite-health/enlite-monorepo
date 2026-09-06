import { z } from 'zod';
import type { Profession } from '../../../worker/domain/enums/Profession';
import { ADMISSION_COUNTRY_CODES } from '../../../matching/domain/admissionCountries';
import { countNameParts } from '../../domain/fullName';

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
    /** Nome completo de quem preenche, em UM campo (D249). Obrigatório desde
     * 02/09: sem ele o lead vira um card indistinguível e ninguém consegue
     * chamar a pessoa pelo nome dentro do SLA de 24h. Reverte a `2026-07-27a#DEC-02`
     * (Diego, 27/07), revalidada em call de produto de 02/09. A quebra em
     * nome/sobrenome é do `CreateLeadUseCase` — o schema só garante que veio algo. */
    name: z
      .string()
      .trim()
      .min(1, { message: 'name is required' })
      // Nome E sobrenome (Gabriel, 02/09): um termo só não identifica ninguém
      // num board com dezenas de cards. A regra é do SERVIDOR, não só da tela —
      // este endpoint é público e um POST direto passa por fora do formulário.
      .refine((v) => countNameParts(v) >= 2, {
        message: 'name must contain first and last name',
      }),
    /** Country the lead belongs to (drives admission scheduling AND the legal
     * regime — LGPD vs Ley 25.326). REQUIRED with no default: a lead silently
     * classified under the wrong jurisdiction is a compliance bug (D108/F0).
     * This schema is the enforcement point of that rule — internal layers
     * (CreateNativePatientInput, insertNative) point here. */
    country: z.enum(ADMISSION_COUNTRY_CODES),
    /** Explicit consent to be contacted (WhatsApp/email), persisted as
     * patients.has_consent (Ley 25.326 / LGPD). MUST be true — the form enforces
     * it client-side, but this is a public unauthenticated endpoint, so the
     * server is the real gate: a direct POST without consent must 400, never
     * store a contactable lead (D108/F0). */
    consent: z.literal(true, {
      errorMap: () => ({ message: 'explicit consent is required' }),
    }),
  })
  .strict();

export type PublicLeadBody = z.infer<typeof publicLeadSchema>;
