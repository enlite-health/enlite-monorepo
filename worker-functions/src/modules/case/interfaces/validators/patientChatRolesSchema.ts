import { z } from 'zod';
import {
  PATIENT_CHAT_ROLE_PATTERN,
  PATIENT_CHAT_ROLE_MAX_LENGTH,
} from '../../domain/PatientChatRole';

const LABEL_MAX_LENGTH = 120;

/**
 * Código do papel — a MESMA forma dos CHECKs `patient_chat_ids_role_shape` (261)
 * e `patient_chat_roles_code_shape` (262). Validar aqui e no banco é de
 * propósito: aqui vira 400 com mensagem legível, lá é a garantia de que nem um
 * psql à mão fura.
 */
const roleCode = z
  .string()
  .trim()
  .min(1)
  .max(PATIENT_CHAT_ROLE_MAX_LENGTH)
  .regex(
    PATIENT_CHAT_ROLE_PATTERN,
    'código do papel deve ser INGLÊS MAIÚSCULO, sem espaço nem acento (ex.: FAMILY, HEALTH_PLAN)',
  );

/**
 * Rótulo exibido. `trim().min(1)` porque rótulo em branco é o mesmo que rótulo
 * ausente — e o banco recusa (`patient_chat_roles_labels_not_blank`). Sem esta
 * linha, "   " passaria pelo schema e estouraria como erro 500 de constraint.
 */
const label = z.string().trim().min(1).max(LABEL_MAX_LENGTH);

/**
 * Palavras de desempate no nome do grupo. Normalizadas aqui (minúsculas, sem
 * acento) para o ranqueamento poder comparar direto, sem normalizar a cada
 * consulta; e sem duplicata, que só inflaria o array.
 *
 * ⚠️ Não são PII: são vocabulário da operação ("flia", "equipo"), nunca o nome
 * de um paciente. Quem digitar um nome de pessoa aqui está errando o campo — o
 * limite de 24 caracteres por palavra torna isso desconfortável de propósito.
 */
const matchKeywords = z
  .array(z.string().trim().min(1).max(24))
  .max(20)
  .transform(words => [
    ...new Set(
      words.map(w => w.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')),
    ),
  ]);

/** POST /api/admin/patient-chat-roles */
export const createPatientChatRoleSchema = z
  .object({
    code: roleCode,
    labelEs: label,
    labelPtBr: label,
    isExclusive: z.boolean().optional().default(true),
    displayOrder: z.number().int().min(0).max(9999).optional().default(0),
    matchKeywords: matchKeywords.optional().default([]),
  })
  .strict();

/**
 * PATCH /api/admin/patient-chat-roles/:code
 *
 * PATCH e não PUT: campo AUSENTE fica inalterado. `code` não entra — trocar o
 * código de um papel em uso renomearia a chave de join da auditoria da Candela
 * sem que ninguém percebesse. Para "renomear", cria-se outro papel.
 */
export const updatePatientChatRoleSchema = z
  .object({
    labelEs: label.optional(),
    labelPtBr: label.optional(),
    isExclusive: z.boolean().optional(),
    displayOrder: z.number().int().min(0).max(9999).optional(),
    isActive: z.boolean().optional(),
    matchKeywords: matchKeywords.optional(),
  })
  .strict()
  .refine(body => Object.keys(body).length > 0, {
    message: 'body vazio: informe pelo menos um campo para alterar',
  });

/** Params de :code — mesma forma do código, para 400 em vez de 404 enganoso. */
export const patientChatRoleParamsSchema = z.object({ code: roleCode });

/** Query de GET — `?includeInactive=true` é a visão da tela de administração. */
export const listPatientChatRolesQuerySchema = z
  .object({
    includeInactive: z
      .enum(['true', 'false'])
      .optional()
      .transform(v => v === 'true'),
  })
  .strict();

export type CreatePatientChatRoleBody = z.infer<typeof createPatientChatRoleSchema>;
export type UpdatePatientChatRoleBody = z.infer<typeof updatePatientChatRoleSchema>;
