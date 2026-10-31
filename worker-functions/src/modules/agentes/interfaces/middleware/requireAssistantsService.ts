import { Request, Response, NextFunction } from 'express';
import {
  ServiceIdentityVerifier,
  createServiceIdentityVerifier,
  readServiceAllowlist,
} from '../../infrastructure/ServiceIdentityVerifier';

export const SERVICE_HEADER = 'x-enlite-service';

function deny(res: Response): void {
  res.status(401).json({ error: 'SERVICE_NOT_AUTHENTICATED' });
}

/**
 * Identity of the SERVICE (assistants SA): own header `X-Enlite-Service: Bearer <Google ID token>`.
 * Verifies audience (in the verifier), email_verified and an e-mail in the allowlist derived from GCP_PROJECT_ID.
 * The PERSON identity (Authorization) is verified separately by requireStaff.
 */
export function requireAssistantsService(injectedVerifier?: ServiceIdentityVerifier) {
  // Resolved lazily (on the 1st call), never at import; the factory only accepts a double with USE_MOCK_AUTH=true.
  let fallback: ServiceIdentityVerifier | undefined;
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const raw = req.headers[SERVICE_HEADER];
    const header = Array.isArray(raw) ? raw[0] : raw;
    if (!header || !header.startsWith('Bearer ') || header.length <= 7) return deny(res);

    let payload;
    try {
      const verifier = injectedVerifier ?? (fallback ??= createServiceIdentityVerifier());
      payload = await verifier.verify(header.slice(7));
    } catch {
      return deny(res);
    }

    if (payload?.email_verified !== true) return deny(res);
    const email = payload.email;
    if (!email || !readServiceAllowlist().includes(email)) return deny(res);
    next();
  };
}
