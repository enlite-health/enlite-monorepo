import { z } from 'zod';

/** Spec 079: preview sem `vacancyId` lista candidatas; com ele devolve a prévia daquela vaga. */
export const linkExistingVacancyPreviewBodySchema = z
  .object({ vacancyId: z.string().uuid().optional() })
  .strict();

export const linkExistingVacancyConfirmBodySchema = z
  .object({ vacancyId: z.string().uuid() })
  .strict();

export type LinkExistingVacancyPreviewBody = z.infer<typeof linkExistingVacancyPreviewBodySchema>;
export type LinkExistingVacancyConfirmBody = z.infer<typeof linkExistingVacancyConfirmBodySchema>;
