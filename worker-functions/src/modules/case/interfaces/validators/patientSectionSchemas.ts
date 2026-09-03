import { z } from 'zod';
import { DOCUMENT_TYPES } from '../../domain/enums/DocumentType';
import { SEXES } from '../../domain/enums/Sex';
import { DEPENDENCY_LEVELS } from '../../domain/enums/DependencyLevel';
import { CLINICAL_SPECIALTIES } from '../../domain/enums/ClinicalSpecialty';
import { PATIENT_STATUSES } from '../../domain/enums/PatientStatus';
import { ON_HOLD_REASONS } from '../../domain/enums/OnHoldReason';
import { RELATIONSHIPS } from '../../domain/enums/Relationship';
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

/**
 * Forma de CÓDIGO de catálogo (device_types.code, insurance_providers.code): a mesma dos CHECKs
 * `*_code_upper` das migrations 307/311. Validar a forma aqui (400) e o pertencimento ao catálogo
 * no repositório (422) — o catálogo muda sem deploy, então o schema não pode listá-lo.
 */
const catalogCode = z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'código de catálogo: MAIÚSCULAS, dígitos e _');

/** Teto de `on_hold_note` no servidor (lex C7.1-f) — espelhado no CHECK da migration 314. */
export const ON_HOLD_NOTE_MAX = 2000;

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
    /** US-B9 (migration 317): data de início do serviço — nativa do painel, não deriva da vaga. */
    serviceStartDate: z.coerce.date().nullable().optional(),
  })
  .strict();

/**
 * section = 'clinical' → the full clinical block (PatientRelatedInput clinical subset).
 * US-B4: `deviceType` (texto livre) SAIU — `patients.device_type` é FK (308) e derivado (310);
 * o drawer manda `deviceTypes`, códigos de `device_types`, que vão para `patient_device_types`.
 */
export const clinicalSectionSchema = z
  .object({
    diagnosis: z.string().nullable().optional(),
    dependencyLevel: z.enum(DEPENDENCY_LEVELS as unknown as [string, ...string[]]).nullable().optional(),
    clinicalSpecialty: z.enum(CLINICAL_SPECIALTIES as unknown as [string, ...string[]]).nullable().optional(),
    clinicalSegments: z.string().nullable().optional(),
    serviceType: z.array(professionEnum).nullable().optional(),
    deviceTypes: z.array(catalogCode).optional(),
    additionalComments: z.string().nullable().optional(),
    emergencyInstructions: z.string().max(4000).nullable().optional(),
    hasJudicialProtection: z.boolean().nullable().optional(),
    hasCud: z.boolean().nullable().optional(),
    hasConsent: z.boolean().nullable().optional(),
  })
  .strict();

/**
 * section = 'coverage' (US-B3) → cobertura informada (texto), nº de afiliado e as coberturas
 * VERIFICADAS por código do catálogo (insurance_providers). IVA e tipo de contratação NÃO
 * entram aqui — são do contrato/pagador (lex C3.3), bloco C.
 */
export const coverageSectionSchema = z
  .object({
    healthInsuranceName: z.string().trim().min(1).nullable().optional(),
    affiliateId: z.string().trim().min(1).nullable().optional(),
    insuranceVerifiedCodes: z.array(catalogCode).optional(),
  })
  .strict();

const responsibleInputSchema = z
  .object({
    firstName: z.string().trim().min(1),
    lastName: z.string().trim().min(1),
    // US-B5: a coluna tem CHECK desde a 139 — recusar aqui é 400 legível, lá seria 23514 → 500.
    relationship: z.enum(RELATIONSHIPS as unknown as [string, ...string[]]).nullable().optional(),
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
  coverage: coverageSectionSchema,
  'support-network': supportNetworkSectionSchema,
  service: serviceSectionSchema,
} as const;

export type PatientSectionName = keyof typeof SECTION_SCHEMAS;

/** Route params for PATCH /:id/:section — id is a UUID, section is a known name. */
export const patientSectionParamSchema = z.object({
  id: z.string().uuid({ message: 'id must be a valid UUID' }),
  section: z.enum(['general', 'clinical', 'coverage', 'support-network', 'service']),
});

/**
 * Body for PUT /api/admin/patients/:id/status (v2). ON_HOLD leva motivo (obrigatório — validado
 * no serviço, que conhece o estado atual) e nota (teto 2000, lex C7.1-f).
 */
export const patientStatusSchema = z
  .object({
    status: z.enum(PATIENT_STATUSES as unknown as [string, ...string[]]),
    onHoldReason: z.enum(ON_HOLD_REASONS as unknown as [string, ...string[]]).nullable().optional(),
    onHoldNote: z.string().max(ON_HOLD_NOTE_MAX).nullable().optional(),
    /** Origem da mudança → `change_source` na history (Historial). Default: admin_panel. */
    changeSource: z.enum(['admin_panel', 'kanban']).optional(),
  })
  .strict();
