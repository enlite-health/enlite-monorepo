import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/**
 * Emissão/verificação stateless de todos os tokens do fluxo OAuth do MCP
 * (JWT HS256, chave única em MCP_OAUTH_SIGNING_KEY). Sem storage: revogação
 * v1 = rotação da chave. O claim `use` separa os tipos de token — um token
 * de um tipo nunca é aceito onde outro tipo é esperado.
 */

const clientPayloadSchema = z.object({
  redirectUris: z.array(z.string()).min(1),
  clientName: z.string().optional(),
});
export type OAuthClientPayload = z.infer<typeof clientPayloadSchema>;

const consentRequestSchema = z.object({
  clientId: z.string(),
  redirectUri: z.string(),
  codeChallenge: z.string(),
  scope: z.string(),
  state: z.string().optional(),
});
export type ConsentRequestPayload = z.infer<typeof consentRequestSchema>;

const authorizationCodeSchema = z.object({
  clientId: z.string(),
  redirectUri: z.string(),
  codeChallenge: z.string(),
  scope: z.string(),
  email: z.string(),
  role: z.string(),
  jti: z.string(),
});
export type AuthorizationCodePayload = z.infer<typeof authorizationCodeSchema>;

const accessTokenSchema = z.object({
  clientId: z.string(),
  scope: z.string(),
  email: z.string(),
  role: z.string(),
  exp: z.number(),
});
export type AccessTokenPayload = z.infer<typeof accessTokenSchema>;

const refreshTokenSchema = z.object({
  clientId: z.string(),
  scope: z.string(),
  email: z.string(),
  role: z.string(),
});
export type RefreshTokenPayload = z.infer<typeof refreshTokenSchema>;

type TokenUse = 'client' | 'consent' | 'code' | 'access' | 'refresh';

export const OAUTH_TOKEN_TTL_SECONDS = {
  consent: 600, // user pode demorar pra logar na página
  code: 60,
  access: 3600,
  refresh: 30 * 24 * 3600,
} as const;

const MIN_KEY_LENGTH = 32;

export class OAuthTokenService {
  constructor(
    private readonly signingKey: string,
    private readonly issuer: string,
  ) {
    if (!signingKey || signingKey.length < MIN_KEY_LENGTH) {
      throw new Error(`OAuthTokenService: signing key must have at least ${MIN_KEY_LENGTH} chars`);
    }
    if (!issuer) {
      throw new Error('OAuthTokenService: issuer required');
    }
  }

  // ── client_id stateless (DCR) ──────────────────────────────────────────────

  signClient(payload: OAuthClientPayload): string {
    // Sem expiração: o client_id precisa sobreviver enquanto o conector existir.
    return this.sign('client', payload);
  }

  verifyClient(clientId: string): OAuthClientPayload | null {
    return this.verify('client', clientId, clientPayloadSchema);
  }

  // ── request context da página de consent ───────────────────────────────────

  signConsentRequest(payload: ConsentRequestPayload): string {
    return this.sign('consent', payload, OAUTH_TOKEN_TTL_SECONDS.consent);
  }

  verifyConsentRequest(token: string): ConsentRequestPayload | null {
    return this.verify('consent', token, consentRequestSchema);
  }

  // ── authorization code ─────────────────────────────────────────────────────

  signCode(payload: Omit<AuthorizationCodePayload, 'jti'>): string {
    return this.sign('code', { ...payload, jti: randomUUID() }, OAUTH_TOKEN_TTL_SECONDS.code);
  }

  verifyCode(code: string): AuthorizationCodePayload | null {
    return this.verify('code', code, authorizationCodeSchema);
  }

  // ── access / refresh tokens ────────────────────────────────────────────────

  signAccess(payload: Omit<AccessTokenPayload, 'exp'>): string {
    return this.sign('access', payload, OAUTH_TOKEN_TTL_SECONDS.access);
  }

  verifyAccess(token: string): AccessTokenPayload | null {
    return this.verify('access', token, accessTokenSchema);
  }

  signRefresh(payload: RefreshTokenPayload): string {
    return this.sign('refresh', payload, OAUTH_TOKEN_TTL_SECONDS.refresh);
  }

  verifyRefresh(token: string): RefreshTokenPayload | null {
    return this.verify('refresh', token, refreshTokenSchema);
  }

  // ── internos ───────────────────────────────────────────────────────────────

  private sign(use: TokenUse, payload: Record<string, unknown>, ttlSeconds?: number): string {
    return jwt.sign({ ...payload, use }, this.signingKey, {
      algorithm: 'HS256',
      issuer: this.issuer,
      ...(ttlSeconds !== undefined ? { expiresIn: ttlSeconds } : {}),
    });
  }

  private verify<T>(use: TokenUse, token: string, schema: z.ZodType<T>): T | null {
    try {
      const decoded = jwt.verify(token, this.signingKey, {
        algorithms: ['HS256'],
        issuer: this.issuer,
      });
      if (typeof decoded !== 'object' || decoded === null) return null;
      if ((decoded as Record<string, unknown>).use !== use) return null;
      const parsed = schema.safeParse(decoded);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
}
