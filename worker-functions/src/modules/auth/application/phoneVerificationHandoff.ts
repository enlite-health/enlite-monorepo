import { randomBytes } from 'crypto';

/** Referência curta e opaca do evento de conflito (sem PII): o time acha o caso pelo log `claim_conflict` e une as fichas. */
export function newConflictRef(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(randomBytes(4), (b) => alphabet[b % alphabet.length]).join('');
}

/**
 * Link de "Quiero unir mis datos" para o número da Luz. O número vem SEMPRE da env (`TWILIO_WHATSAPP_NUMBER`, um dono só, D514):
 * nunca literal no código. Sem a env não há link (o chamador responde o 409 sem `handoffUrl`).
 */
export function buildHandoffUrl(ref: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const digits = (env.TWILIO_WHATSAPP_NUMBER ?? '').replace(/\D/g, '');
  if (!digits) return undefined;
  return `https://wa.me/${digits}?text=${encodeURIComponent(`Quiero unir mis datos (ref. ${ref})`)}`;
}
