import {
  AuthContext,
  Credentials,
  CredentialType,
  Principal,
  PrincipalType,
  RequestMetadata,
} from '../domain/Auth';

export interface ApiKeyEntry {
  principal: Principal;
  scopes: string[];
  expiresAt?: Date;
  hashedSecret: string;
}

/**
 * ApiKeyAuthStrategy
 *
 * Encapsula lookup de API keys no store em memória.
 * Extraído de MultiAuthService para conformar limite de 400 linhas.
 */
export class ApiKeyAuthStrategy {
  private readonly store: Map<string, ApiKeyEntry> = new Map();

  constructor(private readonly enabled: boolean) {
    this.loadFromEnv();
  }

  authenticate(credentials: Credentials, metadata: RequestMetadata): AuthContext | null {
    return this.tryAuthenticate(credentials.token, metadata);
  }

  /**
   * Lookup O(1) sem I/O — para uso em middlewares híbridos.
   */
  tryAuthenticate(token: string, metadata?: RequestMetadata): AuthContext | null {
    if (!this.enabled) return null;

    const entry = this.store.get(token);
    if (!entry) return null;

    if (entry.expiresAt && entry.expiresAt < new Date()) return null;

    const meta: RequestMetadata = metadata ?? {
      ipAddress: 'unknown',
      requestId: `apikey_${Date.now()}`,
      timestamp: new Date(),
      path: '',
      method: '',
    };

    return {
      principal: entry.principal,
      credentials: {
        type: CredentialType.API_KEY,
        token,
        scopes: entry.scopes,
      },
      metadata: meta,
    };
  }

  async generateKey(
    serviceName: string,
    scopes: string[],
    expiresInDays = 365,
  ): Promise<{ apiKey: string; secret: string; expiresAt: Date }> {
    const apiKey = `enlite_${randomString(32)}`;
    const secret = randomString(64);

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + expiresInDays);

    this.store.set(apiKey, {
      principal: { id: `service:${serviceName}`, type: PrincipalType.SERVICE },
      scopes,
      expiresAt,
      hashedSecret: secret, // placeholder — production uses Argon2/bcrypt
    });

    return { apiKey, secret, expiresAt };
  }

  revoke(apiKey: string): boolean {
    return this.store.delete(apiKey);
  }

  private loadFromEnv(): void {
    const raw = process.env.ENLITE_API_KEYS;
    if (!raw) return;

    for (const key of raw.split(',')) {
      const [serviceName, apiKeyValue] = key.split(':');
      if (serviceName && apiKeyValue) {
        this.store.set(apiKeyValue, {
          principal: { id: `service:${serviceName}`, type: PrincipalType.SERVICE },
          scopes: scopesForService(serviceName),
          hashedSecret: '',
        });
      }
    }
  }
}

function randomString(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function scopesForService(name: string): string[] {
  switch (name) {
    case 'n8n':        return ['workers:read', 'workers:write', 'webhooks:execute'];
    case 'react_frontend': return ['workers:read', 'workers:write', 'users:manage'];
    case 'admin':      return ['*'];
    default:           return ['workers:read'];
  }
}
