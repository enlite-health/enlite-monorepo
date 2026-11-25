import { z } from 'zod';

/** Subtypes que o processador entende (fonte única: o schema e o `UNSUPPORTED` do processador leem esta lista). */
export const PRESCREENING_RESPONSE_SUBTYPES = ['INITIATED', 'IN_PROGRESS', 'COMPLETED', 'ANALYZED'] as const;

/** Subtype do evento de criação de vaga (`action: PRESCREENING`). */
export const PRESCREENING_CREATED_SUBTYPE = 'CREATED' as const;

// ─────────────────────────────────────────────────────────────────
// Schemas individuais reutilizados em registerQuestions e response.state
// ─────────────────────────────────────────────────────────────────

const TalentumQuestionItemSchema = z.object({
  questionId:   z.string().min(1).trim(),
  question:     z.string().min(1).trim(),
  answer:       z.string().trim(),        // string vazia permitida (sem resposta ainda)
  responseType: z.string().min(1).trim().optional(), // opcional: ausente em payloads ANALYZED
}).strict();

// ─────────────────────────────────────────────────────────────────
// Sub-schemas do data de PRESCREENING_RESPONSE
// ─────────────────────────────────────────────────────────────────

const TalentumPrescreeningDataSchema = z.object({
  id:   z.string().min(1).trim(),
  name: z.string().min(1).trim(),
  // status removido — agora vem no subtype do envelope
}).strict();

const TalentumProfileDataSchema = z.object({
  id:                z.string().min(1).trim(),
  firstName:         z.string().min(1).trim(),
  lastName:          z.string().min(1).trim(),
  // Aceita Unicode no local-part (RFC 6531 / SMTPUTF8) — Zod default é ASCII-only
  email:             z.string().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Invalid email').toLowerCase().trim(),
  phoneNumber:       z.string().min(1).trim(),
  cuil:              z.string().min(1).trim().optional(),            // opcional
  registerQuestions: z.array(TalentumQuestionItemSchema).default([]), // opcional — default []
}).strict();

const TalentumResponseDataSchema = z.object({
  id:          z.string().min(1).trim(),
  state:       z.array(TalentumQuestionItemSchema).default([]),
  score:       z.number().optional(),                                          // só presente em ANALYZED
  statusLabel: z.enum(['QUALIFIED', 'NOT_QUALIFIED', 'PENDING', 'IN_DOUBT']).optional(),   // só presente em ANALYZED
}).strict();

// ─────────────────────────────────────────────────────────────────
// Variante 1 — action: "PRESCREENING", subtype: "CREATED"
// Notifica a criação de um novo prescreening (vaga aberta no Talentum).
// ─────────────────────────────────────────────────────────────────

const TalentumPrescreeningCreatedSchema = z.object({
  action:  z.literal('PRESCREENING'),
  subtype: z.literal(PRESCREENING_CREATED_SUBTYPE),
  data: z.object({
    _id:  z.string().min(1).trim(),
    name: z.string().min(1).trim(),
  }),
  // sem .strict() — forward-compatibility
});

// ─────────────────────────────────────────────────────────────────
// Variante 2 — action: "PRESCREENING_RESPONSE", subtype: status do processo
// Enviado a cada progresso de um candidato no prescreening.
// ─────────────────────────────────────────────────────────────────

const TalentumPrescreeningResponseSchema = z.object({
  action:  z.literal('PRESCREENING_RESPONSE'),
  subtype: z.enum(PRESCREENING_RESPONSE_SUBTYPES),
  data: z.object({
    prescreening: TalentumPrescreeningDataSchema,
    profile:      TalentumProfileDataSchema,
    response:     TalentumResponseDataSchema,
  }),
  // sem .strict() — forward-compatibility
});

// ─────────────────────────────────────────────────────────────────
// Schema principal — discriminated union pelo campo `action`
// ─────────────────────────────────────────────────────────────────

export const TalentumPrescreeningPayloadSchema = z.discriminatedUnion('action', [
  TalentumPrescreeningCreatedSchema,
  TalentumPrescreeningResponseSchema,
]);

// ─────────────────────────────────────────────────────────────────
// Tipos derivados exportados para uso nos controllers e use cases
// ─────────────────────────────────────────────────────────────────

/** Input bruto (antes do parse) do envelope completo */
export type TalentumPrescreeningPayloadInput = z.input<typeof TalentumPrescreeningPayloadSchema>;

/** Resultado parseado do envelope completo (union das duas variantes) */
export type TalentumPrescreeningPayloadParsed = z.infer<typeof TalentumPrescreeningPayloadSchema>;

/** Resultado parseado da variante PRESCREENING.CREATED */
export type TalentumPrescreeningCreatedParsed = z.infer<typeof TalentumPrescreeningCreatedSchema>;

/** Resultado parseado da variante PRESCREENING_RESPONSE (qualquer subtype) */
export type TalentumPrescreeningResponseParsed = z.infer<typeof TalentumPrescreeningResponseSchema>;
