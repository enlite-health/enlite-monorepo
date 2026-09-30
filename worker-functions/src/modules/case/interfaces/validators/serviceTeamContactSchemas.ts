/**
 * Validadores do modal do prestador (quadro C, rodada 2, decisão D). `note` é texto livre
 * (Notas) — só forma aqui (tamanho), nada de sanitização de conteúdo: o dado é do operador, para
 * o operador, nunca renderizado como HTML.
 */
import { z } from 'zod';

export const serviceTeamContactParamsSchema = z.object({
  id: z.string().uuid(),
  sid: z.string().uuid(),
  workerId: z.string().uuid(),
});

export const serviceTeamContactBodySchema = z.object({
  contacted: z.boolean(),
  eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "eventDate deve ser 'YYYY-MM-DD'"),
  note: z.string().max(4000).nullish(),
});

export type ServiceTeamContactParams = z.infer<typeof serviceTeamContactParamsSchema>;
export type ServiceTeamContactBody = z.infer<typeof serviceTeamContactBodySchema>;
