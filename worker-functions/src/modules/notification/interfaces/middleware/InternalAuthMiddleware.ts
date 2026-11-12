import { Request, Response, NextFunction } from 'express';
import { OAuth2Client } from 'google-auth-library';

const oauth2Client = new OAuth2Client();

/** `X-Internal-Secret` igual a `INTERNAL_TOKEN_SECRET` (Cloud Tasks). Único ponto desta checagem. */
export function hasValidInternalSecret(req: Request): boolean {
  const secret = req.headers['x-internal-secret'];
  const expected = process.env.INTERNAL_TOKEN_SECRET;
  return typeof secret === 'string' && !!secret && !!expected && secret === expected;
}

/**
 * Middleware for internal endpoints (Pub/Sub push, Cloud Tasks).
 *
 * Auth strategies (checked in order):
 * 1. X-Internal-Secret header — used by Cloud Tasks
 * 2. Bearer OIDC token — used by Pub/Sub push subscriptions
 *
 * In dev/test: X-Internal-Secret alone is sufficient.
 */
export async function internalAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // 1. Cloud Tasks: shared secret header
  if (hasValidInternalSecret(req)) {
    return next();
  }

  // 2. Pub/Sub push: Bearer OIDC token
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      await oauth2Client.verifyIdToken({
        idToken: token,
        audience: process.env.CLOUD_RUN_SERVICE_URL,
      });
      return next();
    } catch (err) {
      console.warn('[InternalAuth] OIDC token verification failed:', (err as Error).message);
    }
  }

  res.status(403).json({ error: 'Forbidden' });
}
