/**
 * terminologySearchSchema — GET /api/admin/terminology/search?q=&lang=es&chapters=06,08
 * (spec 016 F2). `.strict()` seria "campo extra vira 400" — mas query string não tem essa
 * garantia de forma nativa; a régua aqui é: só os três campos abaixo são LIDOS, qualquer outro
 * na query é ignorado pelo Express antes de chegar aqui (comportamento padrão de query parsing).
 *
 * 🔧 F5-CORREÇÃO T10 (QA-caça, 05/09/2026) — o piso de tamanho da consulta vinha de TRÊS lugares
 * com DOIS valores: `min(1)` aqui, `MIN_QUERY_LENGTH = 2` no adaptador, `MIN_CHARS = 2` no
 * front. Consequência medida: `?q=a` passava pela validação, o adaptador devolvia `[]` sem tocar
 * o banco, e a API respondia `200 {"candidates":[]}` — "não perguntei" indistinguível de "não
 * há", que é a confusão que a US-4 existe para proibir. Agora o número vem da PORTA
 * (`MIN_SEARCH_QUERY_LENGTH`, fonte única) e a rota RECUSA com 400 DIZENDO o piso, em vez de
 * mentir uma lista vazia.
 */
import { z } from 'zod';
import { MIN_SEARCH_QUERY_LENGTH } from '../../domain/TerminologyPort';

export const terminologySearchQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .min(MIN_SEARCH_QUERY_LENGTH, { message: `q must have at least ${MIN_SEARCH_QUERY_LENGTH} characters` }),
  lang: z.enum(['es', 'en']).optional(),
  chapters: z
    .string()
    .transform((s) => s.split(',').map((c) => c.trim()).filter(Boolean))
    .optional(),
});
export type TerminologySearchQuery = z.infer<typeof terminologySearchQuerySchema>;
