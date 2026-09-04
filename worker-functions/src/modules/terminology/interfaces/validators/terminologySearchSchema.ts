/**
 * terminologySearchSchema — GET /api/admin/terminology/search?q=&lang=es&chapters=06,08
 * (spec 016 F2). `.strict()` seria "campo extra vira 400" — mas query string não tem essa
 * garantia de forma nativa; a régua aqui é: só os três campos abaixo são LIDOS, qualquer outro
 * na query é ignorado pelo Express antes de chegar aqui (comportamento padrão de query parsing).
 */
import { z } from 'zod';

export const terminologySearchQuerySchema = z.object({
  q: z.string().trim().min(1, { message: 'q is required' }),
  lang: z.enum(['es', 'en']).optional(),
  chapters: z
    .string()
    .transform((s) => s.split(',').map((c) => c.trim()).filter(Boolean))
    .optional(),
});
export type TerminologySearchQuery = z.infer<typeof terminologySearchQuerySchema>;
