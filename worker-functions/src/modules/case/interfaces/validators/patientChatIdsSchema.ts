import { z } from 'zod';
import { CHAT_ID_MAX_LENGTH, GROUP_CHAT_ID_PATTERN } from '../../domain/PatientChatId';

const GROUP_ONLY_MESSAGE =
  'chat_id deve ser de GRUPO do Periskope (termina em @g.us). Conversa 1-1 (@c.us) não é aceita.';

const groupChatId = z
  .string()
  .trim()
  .max(CHAT_ID_MAX_LENGTH)
  .regex(GROUP_CHAT_ID_PATTERN, GROUP_ONLY_MESSAGE);

/**
 * Body de PUT /api/admin/patients/:id/chat-ids.
 *
 * Os dois campos são obrigatórios na requisição mas aceitam `null` — a tela
 * grava o par inteiro de uma vez, e `null` é o jeito explícito de DESVINCULAR.
 * `.strict()` transforma campo desconhecido em 400 em vez de no-op silencioso.
 *
 * O par igual é recusado aqui e também no banco (CHECK
 * `patients_chat_ids_distinct`, migration 260): o mesmo grupo não pode ser ao
 * mesmo tempo o da família e o dos prestadores.
 */
export const patientChatIdsSchema = z
  .object({
    familyChatId: groupChatId.nullable(),
    providersChatId: groupChatId.nullable(),
  })
  .strict()
  .refine(
    v => v.familyChatId === null || v.providersChatId === null || v.familyChatId !== v.providersChatId,
    { message: 'familyChatId e providersChatId não podem ser o mesmo grupo', path: ['providersChatId'] },
  );

export type PatientChatIdsBody = z.infer<typeof patientChatIdsSchema>;

/** Query de GET /api/admin/patients/:id/chat-candidates. */
export const patientChatCandidatesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
