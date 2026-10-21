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
import { PATIENT_COMPLETENESS_CODES } from './PatientCompleteness';
import { PATIENT_PROFESSIONAL_SPECIALTY_CODES } from './patientEnums';
import { COVERAGE_MATCH_STATES } from './PatientContractedService';
import { CURRENCIES, PAYER_KINDS } from './InsuranceContract';
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

// Spec 016 F2 (D263), correção C5 (QA-caça): `GET /patients/:id` passou a embutir `diagnoses[]`
// (projeção `DiagnosisPublicView` — REQ-21, sem code/chapter/release) — o schema `.strict()`
// reprovava essa chave nova, mas o teste de drift seguia verde porque a fixture não foi
// recapturada. Fixture recapturada da API REAL em 04/09 (docker `enlite-api` rebuildado desta
// worktree, `AdminPatientsController.js` grep confirmado com `diagnosesUnavailable`).
const diagnosisPublicViewSchema = z
  .object({
    id: z.string(),
    uri: z.string(),
    title: z.string(),
    isPrimary: z.boolean(),
    source: z.string(),
    active: z.boolean(),
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
    addressType: z.string().nullable(),
    addressTypeOther: z.string().nullable(),
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
    // Enum fechado (migration 427, spec 018 PR-5) — z.string() aceitaria qualquer coisa; o
    // contrato usa o mesmo vocabulário fechado do domínio (patientEnums.ts).
    specialty: z.enum(PATIENT_PROFESSIONAL_SPECIALTY_CODES).nullable(),
    displayOrder: z.number(),
    isTeam: z.boolean(),
  })
  .strict();

// Spec 013, bloco C: o serviço contratado como entidade, com prestadores alocados.
const contractedServiceProviderSchema = z
  .object({
    id: z.string(),
    serviceId: z.string(),
    workerId: z.string(),
    workerName: z.string().nullable(),
    active: z.boolean(),
    endedAt: isoDate.nullable(),
    country: z.string(),
    createdAt: isoDate,
    updatedAt: isoDate,
  })
  .strict();

const payerNamesSchema = z
  .object({
    providerCode: z.string(),
    providerName: z.string(),
    contractId: z.string(),
    contractName: z.string(),
    payerKind: z.enum(PAYER_KINDS).nullable(),
  })
  .strict();

const payerSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('NO_CONTRACT') }).strict(),
  z
    .object({
      state: z.literal('LINKED'),
      isPrivate: z.boolean(),
      validFrom: isoDate,
      validTo: isoDate.nullable(),
      names: payerNamesSchema.nullable(),
    })
    .strict(),
]);

const payerHistoryItemSchema = z
  .object({ linkId: z.string(), isPrivate: z.boolean(), validFrom: isoDate, validTo: isoDate.nullable(), names: payerNamesSchema.nullable() })
  .strict();

const priceSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('NO_CONTRACT') }).strict(),
  z.object({ state: z.literal('NO_TERM') }).strict(),
  z.object({ state: z.literal('OK'), hourlyRate: z.number(), currency: z.enum(CURRENCIES) }).strict(),
  z.object({ state: z.literal('REDACTED') }).strict(),
]);

const taxSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('NO_CONTRACT') }).strict(),
  z.object({ state: z.literal('NO_TERM') }).strict(),
  z.object({ state: z.literal('OK'), taxRatePercent: z.number() }).strict(),
]);

// Spec 058 §C: `entries` = { code|null, name|null, mapped, source }; `display`/`displaySource` só alimentam o PDF.
const coverageSchema = z
  .object({
    display: z.string().nullable(),
    displaySource: z.enum(['INFORMED', 'VERIFIED', 'UNMAPPED_ONLY', 'NONE']),
    entries: z.array(z.object({ code: z.string().nullable(), name: z.string().nullable(), mapped: z.boolean(), source: z.string() }).strict()),
  })
  .strict();

const contractedServiceSchema = z
  .object({
    id: z.string(),
    patientId: z.string(),
    serviceCode: z.string(),
    professionalProfile: z.string().nullable(),
    providersNeeded: z.number().nullable(),
    authorization: z
      .object({ id: z.string(), hours: z.number(), validFrom: isoDate, validTo: isoDate })
      .nullable(),
    scheduleHours: z.number(),
    careLocation: z.string().nullable(),
    startDate: isoDate.nullable(),
    // Spec 058 (§G/§P/§D): pagador, preço e imposto NA data `asOf` (dia de operação do país do serviço). `names: null` /
    // `price: REDACTED` / `coverageMatch: REDACTED` = o ator não lê a célula (o imposto nunca é redigido).
    asOf: z.string(),
    payer: payerSchema,
    payerHistory: z.array(payerHistoryItemSchema),
    price: priceSchema,
    tax: taxSchema,
    coverageMatch: z.object({ state: z.enum(COVERAGE_MATCH_STATES) }).strict(),
    supervisionFrequency: z.string().nullable(),
    guardShift: z.string().nullable(),
    // Spec 015 (US-A6.1): franja etária solicitada do prestador — string frouxa, molde do resto.
    providerAgeBand: z.string().nullable(),
    // Migration 330: ponteiro para o endereço + horário do encuadre (array do DayScheduleEditor).
    addressId: z.string().nullable(),
    schedule: z
      .array(z.object({ dayOfWeek: z.number(), startTime: z.string(), durationMinutes: z.number(), endTime: z.string() }))
      .nullable(),
    // Spec 047 (F2): vaga viva do serviço — allow-list de 4 chaves (`.strict()`: campo a mais quebra o parse).
    // `null` + `liveVacancyRedacted: false` = sem vaga; `null` + `true` = o ator não lê vagas (não é "sem vaga").
    liveVacancy: z
      .object({
        id: z.string(),
        caseNumber: z.number().nullable(),
        caseOrdinal: z.number().nullable(),
        status: z.string().nullable(),
      })
      .strict()
      .nullable(),
    liveVacancyRedacted: z.boolean(),
    // Spec 027 Fase 3 (D507/D508): 7 colunas de recrutamento do serviço; `workerAttributes`/`dailyObs` são SÓ FICHA.
    requiredProfessions: z.array(z.string()).nullable(),
    requiredSex: z.string().nullable(),
    requiredExperience: z.string().nullable(),
    workerAttributes: z.string().nullable(),
    workSchedule: z.string().nullable(),
    paymentDay: z.string().nullable(),
    dailyObs: z.string().nullable(),
    active: z.boolean(),
    endedAt: isoDate.nullable(),
    country: z.string(),
    deviceTypes: z.array(z.string()),
    providers: z.array(contractedServiceProviderSchema),
    createdAt: isoDate,
    updatedAt: isoDate,
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
    coverage: coverageSchema.nullable(),
    hasVerifiedActiveCoverage: z.boolean().optional(),
    deviceTypes: z.array(z.string()),
    needsAttention: z.boolean(),
    attentionReasons: z.array(z.string()),
    // Spec 014 (US-D1, lex D1.1): SÓ neste contrato (o do detalhe) — lista/kanban não têm.
    // D255/QA-caça: `blocking`/`canActivate` — só ADDRESS bloqueia o activate de verdade.
    completeness: z
      .object({
        // Migration 330: SERVICE_ADDRESS (serviço ativo sem endereço vivo) entra na lista e
        // também bloqueia — o enum aqui é a fonte `PATIENT_COMPLETENESS_CODES`, não uma cópia.
        missing: z.array(z.enum(PATIENT_COMPLETENESS_CODES)),
        blocking: z.array(z.enum(PATIENT_COMPLETENESS_CODES)),
        ready: z.boolean(),
        canActivate: z.boolean(),
      })
      .strict(),
    phoneMatchesResponsible: z.boolean(),
    responsibles: z.array(responsibleSchema),
    addresses: z.array(addressSchema),
    professionals: z.array(professionalSchema),
    contractedServices: z.array(contractedServiceSchema),
    // Spec 016 F2 (D263), C5 — diagnóstico estruturado (REQ-21: sem code/chapter/release, só
    // {id,uri,title,isPrimary,source,active}). Bulkhead do backend (C4): `diagnosesUnavailable`
    // distingue "paciente sem diagnóstico" ([], false) de "não consegui ler" ([], true).
    // `null` = ator sem `patient_clinical:read` (D113/D286) — DraftVacancyPage.tsx colapsava
    // esse null em `[]` decidindo permissão de novo no cliente (achado do gate revisao-pr).
    diagnoses: z.array(diagnosisPublicViewSchema).nullable(),
    diagnosesUnavailable: z.boolean(),
    lastCaseNumber: z.number().nullable().optional(),
    createdAt: isoDate,
    updatedAt: isoDate,
  })
  .strict() satisfies z.ZodType<PatientDetail>;

export type PatientDetailContract = z.infer<typeof patientDetailContractSchema>;
