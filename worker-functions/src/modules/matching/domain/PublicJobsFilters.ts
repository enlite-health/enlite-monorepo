/**
 * PublicJobsFilters — input to ListActivePublicJobsUseCase and findActivePublic.
 *
 * TD-014: source of truth para o filtro de vagas públicas. Schema Zod canônico
 * vive aqui; controller e OpenAPI registration importam daqui pra evitar drift.
 *
 * Schema é parsing-only (sem metadata OpenAPI). A registration em
 * `shared/openapi/registrations/publicJobs.ts` reusa este schema adicionando
 * `.openapi()` por campo via `.openapi()` extension method do
 * `@asteasolutions/zod-to-openapi`.
 */
import { z } from 'zod';

export const PublicJobsFiltersSchema = z.object({
  country: z
    .string()
    .transform((s: string) => s.toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{2}$/, 'country must be a 2-letter ISO code'))
    .default('AR'),
  state: z.string().trim().min(1).optional(),
  city: z.string().trim().min(1).optional(),
  pathology: z.string().trim().min(1).optional(),
  worker_sex: z.enum(['FEMALE', 'MALE', 'BOTH']).optional(),
  worker_type: z.string().trim().min(1).optional(),
  q: z.string().trim().min(1).optional(),
});

export type PublicJobsFilters = z.infer<typeof PublicJobsFiltersSchema>;
