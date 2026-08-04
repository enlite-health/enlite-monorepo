/**
 * linkToken — tokens HMAC-SHA256 auto-contidos do vínculo de contas.
 *
 * Dois propósitos:
 *   'finalize' — emitido no confirm quando há conflitos (o Twilio Verify CONSOME
 *                o código na 1ª checagem; o finalize precisa de outra credencial).
 *                Vida curta (10 min).
 *   'undo'     — link do email de aviso à conta absorvida ("no fui yo"). 7 dias.
 *
 * Formato: base64url(payload JSON) + '.' + base64url(HMAC(payload)).
 * Segredo: ACCOUNT_LINK_TOKEN_SECRET (Secret Manager em prod). Sem segredo
 * configurado, emissão/validação FALHAM — nunca cair num default previsível.
 */

import crypto from 'crypto';

export interface LinkTokenPayload {
  purpose: 'finalize' | 'undo';
  survivorId: string;
  absorbedId: string;
  /** Presente no undo (aponta a auditoria a desfazer). */
  mergeAuditId?: number;
  /** Epoch ms. */
  exp: number;
}

export const FINALIZE_TOKEN_TTL_MS = 10 * 60 * 1000;
export const UNDO_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function secret(): string {
  const s = process.env.ACCOUNT_LINK_TOKEN_SECRET;
  if (!s) throw new Error('ACCOUNT_LINK_TOKEN_SECRET not configured');
  return s;
}

function hmac(data: string): string {
  return crypto.createHmac('sha256', secret()).update(data).digest('base64url');
}

export function signLinkToken(payload: LinkTokenPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${hmac(body)}`;
}

/** Devolve o payload se válido e não-expirado; null caso contrário. */
export function verifyLinkToken(
  token: string,
  expectedPurpose: LinkTokenPayload['purpose'],
): LinkTokenPayload | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = hmac(body);
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  let payload: LinkTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (payload.purpose !== expectedPurpose) return null;
  if (typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;
  return payload;
}
