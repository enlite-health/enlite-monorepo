import { z } from 'zod';
import { DOCUMENT_TYPES } from '../../domain/enums/DocumentType';
import { PROFESSIONS } from '@modules/worker';

/**
 * createPatientSchema — validates the body of POST /api/admin/patients
 * (manual admin creation of a native patient, migration 251 / Fase 1 Task 2).
 *
 * Only firstName is required. All other fields are optional — the admission
 * team fills the rest later (the patient is created in status ADMISSION to be
 * worked on). The contact-channel invariant (at least one of patient phone /
 * contact email / primary responsible channel) is NOT enforced here: it lives
 * in PatientService.createNativePatient and is surfaced by the controller as a
 * 400 with a clear message.
 */
export const createPatientSchema = z.object({
  firstName: z.string().trim().min(1, { message: 'firstName is required' }),
  lastName: z.string().trim().min(1).optional(),
  /** US-B6 (spec 012): fecha de nacimiento no modal de criação. */
  birthDate: z.coerce.date().optional(),
  phoneWhatsapp: z.string().trim().min(1).optional(),
  contactEmail: z.string().trim().email({ message: 'contactEmail must be a valid email' }).optional(),
  documentType: z.enum(DOCUMENT_TYPES as unknown as [string, ...string[]]).optional(),
  documentNumber: z.string().trim().min(1).optional(),
  healthInsuranceName: z.string().trim().min(1).optional(),
  healthInsuranceMemberId: z.string().trim().min(1).optional(),
  serviceType: z.array(z.enum(PROFESSIONS as unknown as [string, ...string[]])).optional(),
});

export type CreatePatientBody = z.infer<typeof createPatientSchema>;
