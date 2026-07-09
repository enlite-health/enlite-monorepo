import { AuthContext, Credentials, Principal } from '../domain/Auth';

/**
 * Port for Authentication Service
 * 
 * Handles multiple authentication methods:
 * - API Keys (for external SaaS)
 * - JWT tokens (for React frontend users)
 * - mTLS (for service-to-service)
 * - Google Identity Platform tokens
 */
export interface IAuthenticationService {
  /**
   * Authenticate request and return AuthContext
   */
  authenticate(
    credentials: Credentials,
    metadata: { ipAddress: string; userAgent?: string; requestId: string; path: string; method: string }
  ): Promise<AuthContext | null>;

  /**
   * Validate if credentials are still valid
   */
  validateCredentials(credentials: Credentials): Promise<boolean>;

  /**
   * Generate API key for external services (SaaS partners)
   */
  generateApiKey(
    serviceName: string,
    scopes: string[],
    expiresInDays?: number
  ): Promise<{ apiKey: string; secret: string; expiresAt: Date }>;

  /**
   * Revoke API key
   */
  revokeApiKey(apiKey: string): Promise<boolean>;

  /**
   * Parse credentials from request headers
   */
  parseCredentials(headers: Record<string, string>): Credentials | null;
}
