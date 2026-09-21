/**
 * staffDirectorySchema — GET /api/admin/staff-directory?q= (spec 022, T128;
 * `contracts/openapi-staff-directory.md`).
 *
 * Piso de 2 caracteres declarado AQUI, na porta — mesmo padrão de
 * `terminologySearchSchema.ts` (F5-CORREÇÃO T10): `?q=a` tem de RECUSAR com
 * 400, nunca responder 200 com lista vazia (isso confundiria "não perguntei"
 * com "não há resultado").
 */
import { z } from 'zod';

export const MIN_STAFF_DIRECTORY_QUERY_LENGTH = 2;
export const MAX_STAFF_DIRECTORY_RESULTS = 20;

export const staffDirectoryQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .min(MIN_STAFF_DIRECTORY_QUERY_LENGTH, {
      message: `q must have at least ${MIN_STAFF_DIRECTORY_QUERY_LENGTH} characters`,
    }),
});
export type StaffDirectoryQuery = z.infer<typeof staffDirectoryQuerySchema>;
