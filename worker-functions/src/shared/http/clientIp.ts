import type { Request } from 'express';

/** IP do cliente no Cloud Run direto (sem LB): o GFE ACRESCENTA o IP real no FIM do X-Forwarded-For (F3).
 *  O 1º item é escrito pelo cliente e não vale como chave. Sem XFF, `req.ip`. */
export function clientIp(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  const raw = Array.isArray(xff) ? xff.join(',') : xff;
  const last = raw?.split(',').map((s) => s.trim()).filter(Boolean).pop();
  return last ?? req.ip ?? 'unknown';
}
