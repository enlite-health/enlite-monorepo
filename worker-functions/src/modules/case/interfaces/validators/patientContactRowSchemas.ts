import { z } from 'zod';
import {
  COVERAGE_EMERGENCY_CONTACT_KINDS,
  COVERAGE_EMERGENCY_CONTACT_NAME_MAX,
  COVERAGE_EMERGENCY_CONTACT_PHONE_MAX,
} from '../../domain/PatientCoverageEmergencyContact';
import { RELATIONSHIPS } from '../../domain/enums/Relationship';
import {
  PATIENT_PROFESSIONAL_SPECIALTIES,
  PATIENT_PROFESSIONAL_NAME_MAX,
  PATIENT_PROFESSIONAL_PHONE_MAX,
} from '../../domain/PatientProfessional';

/**
 * Validadores da escrita POR LINHA dos contatos do paciente (spec 018, PR-1, ADR-1;
 * `contracts/support-network.md`). Substituem o `PATCH /patients/:id/support-network` (410,
 * SUP-37) e o campo `emergencyContacts` de `PATCH /patients/:id/coverage` (saiu de
 * `patientSectionSchemas.ts`).
 *
 * Mesma convenção dos schemas de seção: `.strict()` (campo a mais = 400), tudo opcional no PATCH
 * (RFC 7396 — ausente não toca; `null` explícito apaga onde a coluna aceita).
 */

export const responsibleIdParamsSchema = z.object({
  id: z.string().uuid(),
  rid: z.string().uuid(),
});

/** `POST /patients/:id/responsibles` — corpo completo (molde `responsibleInputSchema` de `patientSectionSchemas.ts`). */
export const createResponsibleSchema = z
  .object({
    firstName: z.string().trim().min(1),
    lastName: z.string().trim().min(1),
    relationship: z.enum(RELATIONSHIPS as unknown as [string, ...string[]]).nullable().optional(),
    phone: z.string().trim().min(1).nullable().optional(),
    email: z.string().trim().email().nullable().optional(),
    documentType: z.string().trim().min(1).nullable().optional(),
    documentNumber: z.string().trim().min(1).nullable().optional(),
    isPrimary: z.boolean().optional().default(false),
  })
  .strict();

/** `PATCH /patients/:id/responsibles/:rid` — parcial; `isPrimary`/nomes não aceitam `null`. */
export const updateResponsibleSchema = z
  .object({
    firstName: z.string().trim().min(1).optional(),
    lastName: z.string().trim().min(1).optional(),
    relationship: z.enum(RELATIONSHIPS as unknown as [string, ...string[]]).nullable().optional(),
    phone: z.string().trim().min(1).nullable().optional(),
    email: z.string().trim().email().nullable().optional(),
    documentType: z.string().trim().min(1).nullable().optional(),
    documentNumber: z.string().trim().min(1).nullable().optional(),
    isPrimary: z.boolean().optional(),
  })
  .strict();

export const coverageContactIdParamsSchema = z.object({
  id: z.string().uuid(),
  cid: z.string().uuid(),
});

/** `POST /patients/:id/coverage-emergency-contacts` — corpo completo. */
export const createCoverageEmergencyContactSchema = z
  .object({
    kind: z.enum(COVERAGE_EMERGENCY_CONTACT_KINDS),
    name: z.string().trim().min(1).max(COVERAGE_EMERGENCY_CONTACT_NAME_MAX),
    phone: z.string().trim().min(1).max(COVERAGE_EMERGENCY_CONTACT_PHONE_MAX),
  })
  .strict();

/** `PATCH /patients/:id/coverage-emergency-contacts/:cid` — parcial; nenhum campo aceita `null` (colunas NOT NULL). */
export const updateCoverageEmergencyContactSchema = z
  .object({
    kind: z.enum(COVERAGE_EMERGENCY_CONTACT_KINDS).optional(),
    name: z.string().trim().min(1).max(COVERAGE_EMERGENCY_CONTACT_NAME_MAX).optional(),
    phone: z.string().trim().min(1).max(COVERAGE_EMERGENCY_CONTACT_PHONE_MAX).optional(),
  })
  .strict();

// ── Equipe tratante (`patient_professionals`, spec 018 PR-5, US-11) ─────────────────────────────

export const professionalIdParamsSchema = z.object({
  id: z.string().uuid(),
  pid: z.string().uuid(),
});

/** `POST /patients/:id/professionals` — corpo completo. `specialty` enum fechado (C5 do `lex`: o
 * banco também recusa por CHECK — 23514 — a dupla trava é a mesma régua do `kind` de cobertura). */
export const createProfessionalSchema = z
  .object({
    name: z.string().trim().min(1).max(PATIENT_PROFESSIONAL_NAME_MAX),
    phone: z.string().trim().min(1).max(PATIENT_PROFESSIONAL_PHONE_MAX).nullable().optional(),
    email: z.string().trim().email().nullable().optional(),
    specialty: z.enum(PATIENT_PROFESSIONAL_SPECIALTIES).nullable().optional(),
  })
  .strict();

/** `PATCH /patients/:id/professionals/:pid` — parcial; `name` não aceita `null` (coluna NOT NULL). */
export const updateProfessionalSchema = z
  .object({
    name: z.string().trim().min(1).max(PATIENT_PROFESSIONAL_NAME_MAX).optional(),
    phone: z.string().trim().min(1).max(PATIENT_PROFESSIONAL_PHONE_MAX).nullable().optional(),
    email: z.string().trim().email().nullable().optional(),
    specialty: z.enum(PATIENT_PROFESSIONAL_SPECIALTIES).nullable().optional(),
  })
  .strict();
