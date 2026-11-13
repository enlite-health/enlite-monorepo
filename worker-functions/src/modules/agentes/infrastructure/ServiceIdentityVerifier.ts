import { OAuth2Client } from 'google-auth-library';

/** Audience of the ID token of the assistants service SA (constant on both sides; not a secret). The VALUE is an identifier and does not change. */
export const ASSISTANTS_AUDIENCE = 'https://api.enlite.health/assistentes';

/** Audience of the ID token of the mobile BFF service SA (spec 077 A-02, DT-13). */
export const MOBILE_BFF_AUDIENCE = 'https://api.enlite.health/mobile-bff';

export interface ServiceIdentity {
  email?: string;
  email_verified?: boolean;
}

/** Port: validates the service token and returns the payload; rejects if invalid. */
export interface ServiceIdentityVerifier {
  verify(idToken: string): Promise<ServiceIdentity>;
}

/** Allowlist read from GCP_PROJECT_ID (no new env). Without the project, an empty list (fail-closed). */
export function readServiceAllowlist(env: NodeJS.ProcessEnv = process.env, accountId = 'assistants-service-sa'): string[] {
  const project = env.GCP_PROJECT_ID;
  if (!project) return [];
  return [`${accountId}@${project}.iam.gserviceaccount.com`];
}

/** Real verifier: Google OAuth2Client.verifyIdToken with the fixed audience. */
export class GoogleServiceIdentityVerifier implements ServiceIdentityVerifier {
  private readonly client = new OAuth2Client();

  constructor(private readonly audience: string = ASSISTANTS_AUDIENCE) {}

  async verify(idToken: string): Promise<ServiceIdentity> {
    const ticket = await this.client.verifyIdToken({ idToken, audience: this.audience });
    return ticket.getPayload() ?? {};
  }
}

/** Test token prefix (mirrors the `mock_<base64>` of the PERSON identity, MockAuthMiddleware). */
export const MOCK_SERVICE_TOKEN_PREFIX = 'mock_';

/**
 * TEST verifier (e2e): reads `mock_<base64 of {email, email_verified, aud}>` and requires the right audience,
 * as Google would. Never constructed outside USE_MOCK_AUTH=true (see the factory).
 */
export class MockServiceIdentityVerifier implements ServiceIdentityVerifier {
  constructor(private readonly audience: string = ASSISTANTS_AUDIENCE) {}

  async verify(idToken: string): Promise<ServiceIdentity> {
    if (!idToken.startsWith(MOCK_SERVICE_TOKEN_PREFIX)) throw new Error('malformed test token');
    const data = JSON.parse(Buffer.from(idToken.slice(MOCK_SERVICE_TOKEN_PREFIX.length), 'base64').toString());
    if (data?.aud !== this.audience) throw new Error('Wrong recipient');
    return { email: data.email, email_verified: data.email_verified };
  }
}

/**
 * Wiring: the test verifier (injected or the embedded mock) only counts with USE_MOCK_AUTH=true (same switch
 * as the e2e). Otherwise any injected verifier is ignored and only Google counts.
 */
export function createServiceIdentityVerifier(
  testVerifier?: ServiceIdentityVerifier,
  env: NodeJS.ProcessEnv = process.env,
  audience: string = ASSISTANTS_AUDIENCE,
): ServiceIdentityVerifier {
  if (env.USE_MOCK_AUTH === 'true') return testVerifier ?? new MockServiceIdentityVerifier(audience);
  return new GoogleServiceIdentityVerifier(audience);
}
