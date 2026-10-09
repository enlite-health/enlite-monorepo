import { createHash, randomBytes } from 'crypto';

const b64url = (buf: Buffer): string => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** `state` opaco (256 bits). Só existe na URL; o banco guarda o hash. */
export function newOAuthState(): string {
  return b64url(randomBytes(32));
}

/** PKCE (RFC 7636): verifier de 43 caracteres e desafio S256. */
export function newPkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = b64url(randomBytes(32));
  return { codeVerifier, codeChallenge: pkceChallenge(codeVerifier) };
}

export function pkceChallenge(codeVerifier: string): string {
  return b64url(createHash('sha256').update(codeVerifier).digest());
}

export function hashState(state: string): string {
  return createHash('sha256').update(state).digest('hex');
}
