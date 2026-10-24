import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Corpo de criação/substituição. `validTo` é INCLUSIVO (último dia autorizado); `null` é aceito aqui e vira 422 no controller. */
export const authorizationBodySchema = z
  .object({
    hours: z.number().positive().max(100000),
    validFrom: isoDate,
    validTo: isoDate.nullable(),
  })
  .strict()
  .refine((b) => b.validTo === null || b.validTo >= b.validFrom, { message: 'validTo before validFrom' });

export type AuthorizationBody = z.infer<typeof authorizationBodySchema>;
