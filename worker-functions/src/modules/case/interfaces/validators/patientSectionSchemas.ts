import { z } from 'zod';
import { DOCUMENT_TYPES } from '../../domain/enums/DocumentType';
import { SEXES } from '../../domain/enums/Sex';
import { DEPENDENCY_LEVELS } from '../../domain/enums/DependencyLevel';
import { CLINICAL_SPECIALTIES } from '../../domain/enums/ClinicalSpecialty';
import { PATIENT_STATUSES } from '../../domain/enums/PatientStatus';
import { PROFESSIONS } from '@modules/worker';

/**
 * Section-scoped validators for PATCH /api/admin/patients/:id/:section.
 *
 * Each section has its OWN whitelist that mirrors exactly what
 * PatientService.updatePatientSection knows how to persist for that section.
 * `.strict()` makes an unknown field a 400 (whitelist enforcement) instead of a
 * silent no-op. Every field is optional (partial update); `.nullable()` allows
 * explicitly clearing a column to NULL.
 */

const professionEnum = z.enum(PROFESSIONS as unknown as [string, ...string[]]);

/** section = 'general' → identity fields (PatientGeneralSectionData). */
export const generalSectionSchema = z
  .object({
    firstName: z.string().trim().min(1).optional(),
    lastName: z.string().trim().min(1).nullable().optional(),
    birthDate: z.coerce.date().nullable().optional(),
    documentType: z.enum(DOCUMENT_TYPES as unknown as [string, ...string[]]).nullable().optional(),
    documentNumber: z.string().trim().min(1).nullable().optional(),
    affiliateId: z.string().trim().min(1).nullable().optional(),
    sex: z.enum(SEXES as unknown as [string, ...string[]]).nullable().optional(),
    phoneWhatsapp: z.string().trim().min(1).nullable().optional(),
    healthInsuranceName: z.string().trim().min(1).nullable().optional(),
    healthInsuranceMemberId: z.string().trim().min(1).nullable().optional(),
    contactEmail: z.string().trim().email().nullable().optional(),
  })
  .strict();

/** section = 'clinical' → the full clinical block (PatientRelatedInput clinical subset). */
export const clinicalSectionSchema = z
  .object({
    diagnosis: z.string().nullable().optional(),
    dependencyLevel: z.enum(DEPENDENCY_LEVELS as unknown as [string, ...string[]]).nullable().optional(),
    clinicalSpecialty: z.enum(CLINICAL_SPECIALTIES as unknown as [string, ...string[]]).nullable().optional(),
    clinicalSegments: z.string().nullable().optional(),
    serviceType: z.array(professionEnum).nullable().optional(),
    deviceType: z.string().nullable().optional(),
    additionalComments: z.string().nullable().optional(),
    hasJudicialProtection: z.boolean().nullable().optional(),
    hasCud: z.boolean().nullable().optional(),
    hasConsent: z.boolean().nullable().optional(),
  })
  .strict();

const responsibleInputSchema = z
  .object({
    firstName: z.string().trim().min(1),
    lastName: z.string().trim().min(1),
    relationship: z.string().trim().min(1).nullable().optional(),
    phone: z.string().trim().min(1).nullable().optional(),
    email: z.string().trim().email().nullable().optional(),
    documentType: z.string().trim().min(1).nullable().optional(),
    documentNumber: z.string().trim().min(1).nullable().optional(),
    isPrimary: z.boolean(),
    displayOrder: z.number().int(),
    source: z.string().optional(),
  })
  .strict();

/** section = 'support-network' → replaces the responsibles set. */
export const supportNetworkSectionSchema = z
  .object({
    responsibles: z.array(responsibleInputSchema),
  })
  .strict();

/** section = 'service' → only service_type (targeted update, never clobbers clinical). */
export const serviceSectionSchema = z
  .object({
    serviceType: z.array(professionEnum).nullable().optional(),
  })
  .strict();

/**
 * Section → schema map. The controller looks the section up here; an unknown
 * section value is rejected by patientSectionParamSchema before we ever get here.
 */
export const SECTION_SCHEMAS = {
  general: generalSectionSchema,
  clinical: clinicalSectionSchema,
  'support-network': supportNetworkSectionSchema,
  service: serviceSectionSchema,
} as const;

export type PatientSectionName = keyof typeof SECTION_SCHEMAS;

/** Route params for PATCH /:id/:section — id is a UUID, section is a known name. */
export const patientSectionParamSchema = z.object({
  id: z.string().uuid({ message: 'id must be a valid UUID' }),
  section: z.enum(['general', 'clinical', 'support-network', 'service']),
});

/** Body for PUT /api/admin/patients/:id/status. */
export const patientStatusSchema = z.object({
  status: z.enum(PATIENT_STATUSES as unknown as [string, ...string[]]),
});
