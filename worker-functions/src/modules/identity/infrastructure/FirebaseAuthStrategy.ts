import * as admin from 'firebase-admin';
import { Pool } from 'pg';
import { logger } from '@shared/logging';
import { AuthContext, Credentials, CredentialType, Principal, PrincipalType, RequestMetadata } from '../domain/Auth';

/**
 * FirebaseAuthStrategy
 *
 * Encapsula toda lógica de verificação de Firebase ID Tokens,
 * incluindo suporte ao emulador e lookup de role no DB.
 * Extraído de MultiAuthService para conformar limite de 400 linhas.
 */
export class FirebaseAuthStrategy {
  constructor(
    private readonly enabled: boolean,
    private readonly db?: Pool,
  ) {}

  async authenticate(credentials: Credentials, metadata: RequestMetadata): Promise<AuthContext | null> {
    if (!this.enabled) return null;

    try {
      if (process.env.FIREBASE_AUTH_EMULATOR_HOST) {
        return await this.authenticateEmulator(credentials, metadata);
      }
      return await this.authenticateProduction(credentials, metadata);
    } catch (error) {
      logger.error({ err: error }, '[AUTH] Failed to verify Firebase ID token');
      return null;
    }
  }

  private async authenticateEmulator(credentials: Credentials, metadata: RequestMetadata): Promise<AuthContext | null> {
    logger.info('[AUTH] Emulator mode - processing token...');

    const tokenParts = credentials.token.split('.');
    if (tokenParts.length === 3) {
      try {
        const payload = JSON.parse(Buffer.from(tokenParts[1], 'base64').toString()) as {
          user_id?: string;
          sub?: string;
          role?: string;
        };
        logger.info({ userId: payload.user_id ?? payload.sub }, '[AUTH] Emulator JWT decoded');

        const roles: string[] = payload.role ? [payload.role] : [];
        const principal: Principal = {
          id: payload.user_id ?? payload.sub ?? 'emulator-user',
          type: PrincipalType.USER,
          roles,
        };
        return this.buildContext(principal, credentials, metadata);
      } catch (decodeError) {
        logger.error({ err: decodeError }, '[AUTH] Failed to decode JWT');
      }
    } else {
      logger.info('[AUTH] Non-JWT token detected in emulator mode, accepting anyway');
      const principal: Principal = { id: 'emulator-user', type: PrincipalType.USER };
      return this.buildContext(principal, credentials, metadata);
    }
    return null;
  }

  private async authenticateProduction(credentials: Credentials, metadata: RequestMetadata): Promise<AuthContext | null> {
    const decodedToken = await admin.auth().verifyIdToken(credentials.token);
    const claimRole = decodedToken.role as string | undefined;
    const role = claimRole ?? await this.getRoleFromDB(decodedToken.uid, decodedToken.email);
    const principal: Principal = {
      id: decodedToken.uid,
      type: PrincipalType.USER,
      roles: role ? [role] : [],
    };
    return this.buildContext(principal, credentials, metadata);
  }

  private buildContext(principal: Principal, credentials: Credentials, metadata: RequestMetadata): AuthContext {
    return {
      principal,
      credentials: {
        ...credentials,
        type: CredentialType.GOOGLE_ID_TOKEN,
        scopes: ['workers:read', 'workers:write', 'users:manage'],
      },
      metadata,
    };
  }

  private async getRoleFromDB(uid: string, email?: string): Promise<string | null> {
    if (!this.db) return null;
    try {
      const result = await this.db.query<{ role: string }>(
        'SELECT role FROM users WHERE (firebase_uid = $1 OR email = $2) AND is_active = true LIMIT 1',
        [uid, email ?? ''],
      );
      return result.rows[0]?.role ?? null;
    } catch {
      return null;
    }
  }
}
