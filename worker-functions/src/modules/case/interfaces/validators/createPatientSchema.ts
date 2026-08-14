import { z } from 'zod';
import { DOCUMENT_TYPES } from '../../domain/enums/DocumentType';
import { PROFESSIONS } from '@modules/worker';
import { ADMISSION_COUNTRY_CODES } from '../../../matching/domain/admissionCountries';

/**
 * createPatientSchema — validates the body of POST /api/admin/patients
 * (manual admin creation of a native patient, migration 251 / Fase 1 Task 2).
 *
 * firstName and country are required. All other fields are optional — the
 * admission team fills the rest later (the patient is created in status
 * ADMISSION to be worked on). The contact-channel invariant (at least one of
 * patient phone / contact email / primary responsible channel) is NOT enforced
 * here: it lives in PatientService.createNativePatient and is surfaced by the
 * controller as a 400 with a clear message.
 */
export const createPatientSchema = z.object({
  firstName: z.string().trim().min(1, { message: 'firstName is required' }),
  /** Country the patient belongs to — drives admission scheduling AND the legal
   * regime (LGPD vs Ley 25.326). REQUIRED with no default: this endpoint used to
   * hardcode 'AR' at the use-case edge, so a BR patient created from the panel
   * landed as AR and vanished from BR-filtered views. A person silently
   * classified under the wrong jurisdiction is a compliance bug — the operation
   * must fail visibly instead (D108/F0, spec country-isolation: "Criação sem
   * país é rejeitada"). Mirrors publicLeadSchema.country (abac-pais-fase1 5.1). */
  country: z.enum(ADMISSION_COUNTRY_CODES, {
    errorMap: () => ({ message: 'country is required and must be one of AR, BR' }),
  }),
  lastName: z.string().trim().min(1).optional(),
  phoneWhatsapp: z.string().trim().min(1).optional(),
  contactEmail: z.string().trim().email({ message: 'contactEmail must be a valid email' }).optional(),
  documentType: z.enum(DOCUMENT_TYPES as unknown as [string, ...string[]]).optional(),
  documentNumber: z.string().trim().min(1).optional(),
  healthInsuranceName: z.string().trim().min(1).optional(),
  healthInsuranceMemberId: z.string().trim().min(1).optional(),
  serviceType: z.array(z.enum(PROFESSIONS as unknown as [string, ...string[]])).optional(),
});

export type CreatePatientBody = z.infer<typeof createPatientSchema>;
