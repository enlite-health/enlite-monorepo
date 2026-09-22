/**
 * staffDirectorySchema — GET /api/admin/staff-directory?q= (spec 022, T128;
 * `contracts/openapi-staff-directory.md`).
 *
 * Piso de 2 caracteres declarado AQUI, na porta — mesmo padrão de
 * `terminologySearchSchema.ts` (F5-CORREÇÃO T10): `?q=a` tem de RECUSAR com
 * 400, nunca responder 200 com lista vazia (isso confundiria "não perguntei"
 * com "não há resultado").
 *
 * Revoga D-06 (change 022-ux-mencao-e-notificacao, item 1; `fatos-medidos.md` F2): `q`
 * AUSENTE ou VAZIO agora é aceito — passa a significar "sem filtro, listar os primeiros N do
 * diretório" (`AdminRepository.searchStaffDirectory` pula a cláusula `ILIKE` nesse caso). O piso
 * de 2 caracteres continua valendo SÓ quando `q` está presente com texto — `?q=a` continua 400.
 */
import { z } from 'zod';

export const MIN_STAFF_DIRECTORY_QUERY_LENGTH = 2;
export const MAX_STAFF_DIRECTORY_RESULTS = 20;

export const staffDirectoryQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .optional()
    .refine((value) => value === undefined || value.length === 0 || value.length >= MIN_STAFF_DIRECTORY_QUERY_LENGTH, {
      message: `q must have at least ${MIN_STAFF_DIRECTORY_QUERY_LENGTH} characters`,
    }),
});
export type StaffDirectoryQuery = z.infer<typeof staffDirectoryQuerySchema>;
