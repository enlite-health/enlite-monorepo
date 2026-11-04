/**
 * InsuranceProviderDetail — a obra social no cadastro (spec 058 Parte A, §3.2 §W): lista, Dados gerais, cascata do serviço,
 * contatos (Empregados) e pacientes (§L). Mirrors `AdminInsuranceProvidersController`/`AdminInsuranceProviderContactsController`.
 *
 * O NOME vem sempre do banco (C3): não existe i18n por código de obra social.
 */
import { z } from 'zod';
import { PAYER_KINDS } from './InsuranceContract';
import { WORKER_DOCUMENT_TYPES } from './Worker';

const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const payerKind = z.enum(PAYER_KINDS).nullable();

/** `GET /insurance-providers` — item da lista da página. */
export const insuranceProviderListItemSchema = z
  .object({ code: z.string(), name: z.string(), payerKind, active: z.boolean() })
  .strict();
export type InsuranceProviderListItem = z.infer<typeof insuranceProviderListItemSchema>;
export const insuranceProviderListSchema = z.object({ items: z.array(insuranceProviderListItemSchema) }).strict();

/** `GET /insurance-providers/:code` — Dados gerais. */
export const insuranceProviderDetailSchema = z
  .object({
    code: z.string(),
    name: z.string(),
    payerKind,
    active: z.boolean(),
    legalName: z.string().nullable(),
    taxId: z.string().nullable(),
    address: z.string().nullable(),
    managementChatId: z.string().nullable(),
    sortOrder: z.number(),
  })
  .strict();
export type InsuranceProviderDetail = z.infer<typeof insuranceProviderDetailSchema>;

/** `POST /catalogs/insurance-providers` — 201. */
export const createdInsuranceProviderSchema = z
  .object({ code: z.string(), name: z.string(), active: z.boolean(), sortOrder: z.number() })
  .strict();
export type CreatedInsuranceProvider = z.infer<typeof createdInsuranceProviderSchema>;

export interface CreateInsuranceProviderBody {
  name: string;
  code?: string;
  sortOrder?: number;
  aliases?: string[];
}

/** `PATCH /insurance-providers/:code` — ausente = não toca; `null` limpa só os anuláveis; `''` é 422. `code` é imutável. */
export interface PatchInsuranceProviderBody {
  name?: string;
  legalName?: string | null;
  taxId?: string | null;
  address?: string | null;
  managementChatId?: string | null;
  payerKind?: (typeof PAYER_KINDS)[number] | null;
  active?: boolean;
}

/** `GET /insurance-providers/for-service?country=` — cascata do serviço contratado (nunca traz `payerKind`). */
export const insuranceProvidersForServiceSchema = z
  .object({ providers: z.array(z.object({ code: z.string(), name: z.string() }).strict()), asOf: calendarDate })
  .strict();
export type InsuranceProvidersForService = z.infer<typeof insuranceProvidersForServiceSchema>;

/** Contato (Empregados). `redacted: true` = sem `insurance_provider_contacts:read` (telefone, e-mail e número do documento vêm `null`). */
export const insuranceProviderContactSchema = z
  .object({
    id: z.string(),
    fullName: z.string(),
    roleTitle: z.string(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
    // Mesmo vocabulário do documento do worker (spec 058 §10: sem lista nova).
    document: z.object({ type: z.enum(WORKER_DOCUMENT_TYPES), number: z.string().nullable() }).strict().nullable(),
    retired: z.boolean(),
    redacted: z.boolean(),
  })
  .strict();
export type InsuranceProviderContact = z.infer<typeof insuranceProviderContactSchema>;
export const insuranceProviderContactListSchema = z.object({ items: z.array(insuranceProviderContactSchema) }).strict();

export interface InsuranceContactBody {
  fullName: string;
  roleTitle: string;
  phone: string;
  email?: string | null;
  documentType?: (typeof WORKER_DOCUMENT_TYPES)[number] | null;
  documentNumber?: string | null;
}
export type PatchInsuranceContactBody = Partial<InsuranceContactBody>;

/** §L — paciente com vínculo vigente na obra social. */
export const insuranceProviderPatientSchema = z
  .object({
    patientId: z.string(),
    caseNumber: z.number().nullable(),
    contractedServiceId: z.string(),
    contractName: z.string(),
    validFrom: calendarDate,
    validTo: calendarDate.nullable(),
    asOf: calendarDate,
  })
  .strict();
export type InsuranceProviderPatient = z.infer<typeof insuranceProviderPatientSchema>;
export const insuranceProviderPatientListSchema = z.object({ items: z.array(insuranceProviderPatientSchema) }).strict();
