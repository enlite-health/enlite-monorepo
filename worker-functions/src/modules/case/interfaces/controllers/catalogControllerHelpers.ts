import type { Request, Response } from 'express';
import { z } from 'zod';
import { AuthMiddleware } from '@modules/identity';

export const catalogItemParamsSchema = z.object({ itemId: z.string().uuid() });

export const invalidBody = (res: Response, error: z.ZodError): void => {
  // Só NOMES de campo, nunca o valor: o corpo carrega texto clínico (lex C6).
  res.status(400).json({ success: false, error: 'Invalid body', details: { fields: Object.keys(error.flatten().fieldErrors) } });
};

export const actorUidOf = (req: Request): string => AuthMiddleware.getAuthContext(req)?.principal.id ?? 'unknown';
