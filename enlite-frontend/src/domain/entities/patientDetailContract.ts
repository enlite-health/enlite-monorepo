/**
 * Contrato da ficha do paciente — o que `GET /api/admin/patients/:id` devolve.
 *
 * Espelha `PatientDetailRow` do backend (`PatientDetailQueryHelper.ts`). O
 * `satisfies z.ZodType<PatientDetail>` amarra este schema à entidade: se a
 * entidade ganhar um campo que a API não manda (ou ler uma chave com outro
 * nome, como `fullName` × `name`), o `tsc` reprova aqui — e o teste de contrato
 * (`__tests__/patientDetailContract.test.ts`) reprova em runtime contra a
 * fixture capturada da API real. Foi assim que `professionals[].fullName` e
 * `addresses[].fullAddress` ficaram meses rendendo `—` na ficha (spec 011, A2).
 *
 * `.strict()` em todo objeto: chave a mais na API é drift de contrato tanto
 * quanto chave a menos — e é o que faz a fixture ser prova, não decoração.
 */
import { z } from 'zod';
import type { PatientDetail } from './PatientDetail';

const isoDate = z.string();

const responsibleSchema = z
  .object({
    id: z.string(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    relationship: z.string().nullable(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
    documentType: z.string().nullable(),
    documentNumber: z.string().nullable(),
    isPrimary: z.boolean(),
    displayOrder: z.number(),
    source: z.string(),
  })
  .strict();

const availabilityRangeSchema = z.object({ start: z.string(), end: z.string() }).strict();

const availabilityPerDaySchema = z
  .object({
    dayOfWeek: z.number(),
    coveredHours: z.number(),
    availableRanges: z.array(availabilityRangeSchema),
  })
  .strict();

const availabilitySchema = z
  .object({
    totalCoveredHours: z.number(),
    maxHours: z.literal(168),
    isFull: z.boolean(),
    perDay: z.array(availabilityPerDaySchema),
    activeVacanciesCount: z.number(),
    hasUnknownSchedule: z.boolean(),
  })
  .strict();

const addressSchema = z
  .object({
    id: z.string(),
    addressType: z.string(),
    addressFormatted: z.string().nullable(),
    addressRaw: z.string().nullable(),
    complement: z.string().nullable(),
    displayOrder: z.number(),
    lat: z.number().nullable(),
    lng: z.number().nullable(),
    isPrimary: z.boolean(),
    neighborhood: z.string().nullable(),
    logisticsCorridor: z.string().nullable(),
    accessNotes: z.string().nullable(),
    country: z.string().nullable(),
    availability: availabilitySchema.optional(),
  })
  .strict();

const professionalSchema = z
  .object({
    id: z.string(),
    name: z.string().nullable(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
    displayOrder: z.number(),
    isTeam: z.boolean(),
  })
  .strict();

export const patientDetailContractSchema = z
  .object({
    id: z.string(),
    clickupTaskId: z.string().nullable(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    birthDate: isoDate.nullable(),
    documentType: z.string().nullable(),
    documentNumber: z.string().nullable(),
    affiliateId: z.string().nullable(),
    sex: z.string().nullable(),
    phoneWhatsapp: z.string().nullable(),
    /** E-mail do paciente (spec 011, A4): descriptografado só no detalhe. */
    contactEmail: z.string().nullable(),
    chatIds: z.record(z.string().optional()),
    familyChatId: z.string().nullable(),
    providersChatId: z.string().nullable(),
    diagnosis: z.string().nullable(),
    dependencyLevel: z.string().nullable(),
    clinicalSpecialty: z.string().nullable(),
    clinicalSegments: z.string().nullable(),
    serviceType: z.array(z.string()).nullable(),
    deviceType: z.string().nullable(),
    additionalComments: z.string().nullable(),
    additionalCommentsUpdatedAt: isoDate.nullable(),
    additionalCommentsUpdatedBy: z.string().nullable(),
    emergencyInstructions: z.string().nullable(),
    emergencyInstructionsUpdatedAt: isoDate.nullable(),
    emergencyInstructionsUpdatedBy: z.string().nullable(),
    emergencyInstructionsRedacted: z.boolean().optional(),
    hasJudicialProtection: z.boolean().nullable(),
    hasCud: z.boolean().nullable(),
    hasConsent: z.boolean().nullable(),
    insuranceInformed: z.string().nullable(),
    insuranceVerified: z.string().nullable(),
    cityLocality: z.string().nullable(),
    province: z.string().nullable(),
    zoneNeighborhood: z.string().nullable(),
    country: z.string(),
    status: z.string().nullable(),
    admissionStatus: z.string(),
    onHoldReason: z.string().nullable(),
    onHoldNote: z.string().nullable(),
    onHoldNoteRedacted: z.boolean().optional(),
    serviceStartDate: isoDate.nullable(),
    insuranceVerifiedCodes: z.array(z.string()),
    insuranceVerifiedEntries: z.array(z.object({ code: z.string(), source: z.string() })).optional(),
    deviceTypes: z.array(z.string()),
    needsAttention: z.boolean(),
    attentionReasons: z.array(z.string()),
    responsibles: z.array(responsibleSchema),
    addresses: z.array(addressSchema),
    professionals: z.array(professionalSchema),
    lastCaseNumber: z.number().nullable().optional(),
    createdAt: isoDate,
    updatedAt: isoDate,
  })
  .strict() satisfies z.ZodType<PatientDetail>;

export type PatientDetailContract = z.infer<typeof patientDetailContractSchema>;
