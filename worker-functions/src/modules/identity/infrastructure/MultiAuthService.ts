import { Pool } from 'pg';
import { IAuthenticationService } from '../ports/IAuthenticationService';
import {
  AuthContext,
  Credentials,
  CredentialType,
  RequestMetadata,
} from '../domain/Auth';
import * as admin from 'firebase-admin';
import { ApiKeyAuthStrategy } from './ApiKeyAuthStrategy';
import { FirebaseAuthStrategy } from './FirebaseAuthStrategy';

// Initialize Firebase Admin SDK if not already initialized
if (!admin.apps.length) {
  const projectId =
    process.env.GCP_PROJECT_ID ??
    process.env.FIREBASE_PROJECT_ID ??
    (process.env.NODE_ENV === 'production' ? 'enlite-prd' : 'enlite-e2e-test');
  const storageBucket = process.env.GCS_BUCKET_NAME ?? `${projectId}.appspot.com`;

  admin.initializeApp({ projectId, storageBucket });

  console.log('[Firebase Admin] Initialized with project:', projectId, '| bucket:', storageBucket);

  if (process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    console.log('[Firebase Admin] Auth Emulator configured:', process.env.FIREBASE_AUTH_EMULATOR_HOST);
  }
}

export interface MultiAuthConfig {
  googleClientId?: string;
  internalTokenSecret?: string;
  jwtSecret?: string;
  enableApiKeys: boolean;
  enableJwt: boolean;
  enableGoogleIdToken: boolean;
}

/**
 * Multi-Strategy Authentication Service
 *
 * Strategies (delegated to sub-classes):
 *   - ApiKeyAuthStrategy  — API keys (n8n, triage-service, external SaaS)
 *   - FirebaseAuthStrategy — Google/Firebase ID tokens (React frontend)
 *
 * HIPAA: No PII in tokens. Audit log for all auth attempts.
 */
export class MultiAuthService implements IAuthenticationService {
  private readonly apiKeyStrategy: ApiKeyAuthStrategy;
  private readonly firebaseStrategy: FirebaseAuthStrategy;

  constructor(
    private readonly config: MultiAuthConfig,
    private readonly db?: Pool,
  ) {
    this.apiKeyStrategy = new ApiKeyAuthStrategy(config.enableApiKeys);
    this.firebaseStrategy = new FirebaseAuthStrategy(config.enableGoogleIdToken, db);
  }

  async authenticate(
    credentials: Credentials,
    metadata: RequestMetadata,
  ): Promise<AuthContext | null> {
    switch (credentials.type) {
      case CredentialType.API_KEY:
        return this.apiKeyStrategy.authenticate(credentials, metadata);

      case CredentialType.JWT:
        // Not yet implemented
        return null;

      case CredentialType.GOOGLE_ID_TOKEN:
        return this.firebaseStrategy.authenticate(credentials, metadata);

      case CredentialType.INTERNAL_TOKEN:
        // Not yet implemented
        return null;

      case CredentialType.MTLS:
        return this.authenticateMtls(credentials, metadata);

      default:
        return null;
    }
  }

  async validateCredentials(credentials: Credentials): Promise<boolean> {
    const ctx = await this.authenticate(credentials, {
      ipAddress: '127.0.0.1',
      requestId: 'validation-check',
      timestamp: new Date(),
      path: '/health',
      method: 'GET',
    });
    return ctx !== null;
  }

  parseCredentials(headers: Record<string, string>): Credentials | null {
    const apiKey = headers['x-api-key'];
    if (apiKey) {
      return { type: CredentialType.API_KEY, token: apiKey, scopes: [] };
    }

    const authHeader = headers['authorization'];
    if (authHeader?.startsWith('Bearer ')) {
      return { type: CredentialType.GOOGLE_ID_TOKEN, token: authHeader.substring(7), scopes: [] };
    }

    const googleToken = headers['x-google-id-token'];
    if (googleToken) {
      return { type: CredentialType.GOOGLE_ID_TOKEN, token: googleToken, scopes: [] };
    }

    const internalToken = headers['x-internal-token'];
    if (internalToken) {
      return { type: CredentialType.INTERNAL_TOKEN, token: internalToken, scopes: [] };
    }

    return null;
  }

  /**
   * Lookup O(1) por API key sem I/O.
   * Retorna AuthContext se válido, null caso contrário.
   * Usado em requireStaffOrApiKey para testar API key ANTES de chamar Firebase.
   */
  tryAuthenticateAsApiKey(token: string): AuthContext | null {
    return this.apiKeyStrategy.tryAuthenticate(token);
  }

  /**
   * Autentica token Google/Firebase.
   * Exposto publicamente para uso em requireStaffOrApiKey.
   */
  async authenticateGoogleIdToken(
    credentialsOrToken: Credentials | string,
    metadata?: RequestMetadata,
  ): Promise<AuthContext | null> {
    const credentials: Credentials =
      typeof credentialsOrToken === 'string'
        ? { type: CredentialType.GOOGLE_ID_TOKEN, token: credentialsOrToken, scopes: [] }
        : credentialsOrToken;

    const meta: RequestMetadata = metadata ?? {
      ipAddress: 'unknown',
      requestId: `firebase_${Date.now()}`,
      timestamp: new Date(),
      path: '',
      method: '',
    };

    return this.firebaseStrategy.authenticate(credentials, meta);
  }

  async generateApiKey(
    serviceName: string,
    scopes: string[],
    expiresInDays = 365,
  ): Promise<{ apiKey: string; secret: string; expiresAt: Date }> {
    return this.apiKeyStrategy.generateKey(serviceName, scopes, expiresInDays);
  }

  async revokeApiKey(apiKey: string): Promise<boolean> {
    return this.apiKeyStrategy.revoke(apiKey);
  }

  // ============ Private ============

  private authenticateMtls(
    credentials: Credentials,
    metadata: RequestMetadata,
  ): AuthContext | null {
    // mTLS typically handled at infrastructure level; placeholder
    const clientCert = metadata.userAgent?.includes('mTLS');
    if (!clientCert) return null;

    return {
      principal: { id: 'mtls-client', type: 'service' as never },
      credentials,
      metadata,
    };
  }
}
