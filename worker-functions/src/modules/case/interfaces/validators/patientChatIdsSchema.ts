import { z } from 'zod';
import { CHAT_ID_MAX_LENGTH, GROUP_CHAT_ID_PATTERN } from '../../domain/PatientChatId';
import type { PatientChatIdWriteMap } from '../../domain/PatientChatId';
import {
  PATIENT_CHAT_ROLE_PATTERN,
  PATIENT_CHAT_ROLE_MAX_LENGTH,
} from '../../domain/PatientChatRole';
import { MAX_GROUP_PAGE_SIZE } from '../../application/ListChatGroupsUseCase';

const GROUP_ONLY_MESSAGE =
  'chat_id deve ser de GRUPO do Periskope (termina em @g.us). Conversa 1-1 (@c.us) não é aceita.';

const groupChatId = z
  .string()
  .trim()
  .max(CHAT_ID_MAX_LENGTH)
  .regex(GROUP_CHAT_ID_PATTERN, GROUP_ONLY_MESSAGE);

/**
 * O objeto `chatIds` do body.
 *
 * ⚠️ Aqui só se valida a FORMA. Quais papéis existem é DADO (tabela
 * `patient_chat_roles`, administrada na tela), não código — então o schema não
 * pode carregar a lista. Quem confere o vocabulário contra o catálogo é o
 * serviço, que devolve `UNKNOWN_CHAT_ROLE` com os códigos recusados. Um schema
 * com a lista embutida voltaria a exigir deploy a cada papel novo, que é
 * exatamente o que esta mudança elimina.
 *
 * Semântica de cada chave:
 *   null    → DESVINCULA
 *   string  → vincula (só @g.us)
 * Chave AUSENTE não é mexida — é o que permite uma versão antiga do painel
 * salvar sem apagar um papel que ela nem sabe que existe.
 */
const roleCode = z
  .string()
  .trim()
  .max(PATIENT_CHAT_ROLE_MAX_LENGTH)
  .regex(
    PATIENT_CHAT_ROLE_PATTERN,
    'papel deve ser um código em INGLÊS MAIÚSCULO (ex.: FAMILY, HEALTH_PLAN)',
  );

const chatIdsObject = z.record(roleCode, groupChatId.nullable());

/** Contrato novo: um mapa de papéis. */
const roleBody = z.object({ chatIds: chatIdsObject }).strict();

/**
 * Contrato LEGADO da migration 260 — `{ familyChatId, providersChatId }`.
 *
 * @deprecated Aceito só enquanto um bundle antigo do painel puder estar em
 * cache no navegador de quem opera. O painel novo manda `chatIds`. Sai junto com
 * a migration de contract (`migrations/pending/`).
 *
 * Traduzido para o mapa: os dois campos eram obrigatórios lá, então o body
 * legado descreve o par inteiro e `null` desvincula — exatamente como antes.
 */
const legacyBody = z
  .object({
    familyChatId: groupChatId.nullable(),
    providersChatId: groupChatId.nullable(),
  })
  .strict();

/**
 * Body de PUT /api/admin/patients/:id/chat-ids.
 *
 * Aceita o contrato novo OU o legado e devolve sempre o mapa normalizado.
 */
export const patientChatIdsSchema = z
  .union([roleBody, legacyBody])
  .transform((body): PatientChatIdWriteMap => {
    if ('chatIds' in body) {
      // Chave presente com `undefined` (JSON não produz isso, mas um cliente
      // TypeScript sim) é o mesmo que ausente: não mexe.
      return Object.fromEntries(
        Object.entries(body.chatIds).filter(([, v]) => v !== undefined),
      ) as PatientChatIdWriteMap;
    }
    return { FAMILY: body.familyChatId, PROVIDERS: body.providersChatId };
  })
  .superRefine((map, ctx) => {
    // O mesmo grupo em dois papéis do MESMO paciente é recusado aqui e também no
    // banco (UNIQUE `patient_chat_ids_one_role_per_chat`, migration 261).
    const seen = new Map<string, string>();
    for (const [role, chatId] of Object.entries(map)) {
      if (chatId === null) continue;
      const first = seen.get(chatId);
      if (first) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [role],
          message: `o mesmo grupo não pode ser ${first} e ${role} do mesmo paciente`,
        });
        return;
      }
      seen.set(chatId, role);
    }
  });

export type PatientChatIdsBody = z.infer<typeof patientChatIdsSchema>;

/** Query de GET /api/admin/patients/:id/chat-candidates. */
export const patientChatCandidatesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

/**
 * Query de GET /api/admin/patients/chat-map.
 * `chatId` liga a direção REVERSA (de qual paciente é este grupo) e, quando
 * presente, torna `filter`/`offset` irrelevantes — é busca por chave única.
 */
export const patientChatMapQuerySchema = z
  .object({
    filter: z.enum(['linked', 'unlinked', 'all']).optional(),
    chatId: groupChatId.optional(),
    limit: z.coerce.number().int().min(1).max(1000).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict();

/**
 * Query de GET /api/admin/chat-groups — a lista de TODOS os grupos da org.
 *
 * `search` casa por NOME do grupo. Sem ele, devolve a lista inteira paginada:
 * é assim que o operador acha o grupo da obra social, que não se parece com o
 * nome de paciente nenhum.
 */
export const chatGroupsQuerySchema = z
  .object({
    search: z.string().trim().max(120).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_GROUP_PAGE_SIZE).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict();
