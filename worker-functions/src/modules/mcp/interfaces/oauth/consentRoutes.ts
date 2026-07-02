import { Router } from 'express';
import type { Request, Response } from 'express';
import * as admin from 'firebase-admin';
import { z } from 'zod';
import type { OAuthTokenService } from '../../application/oauth/OAuthTokenService';
import type { McpAuditEvent } from '../../domain/McpAuditEvent';
import { logger } from '@shared/logging';

export interface StaffRecord {
  email: string;
  role: string;
}

export interface StaffLookup {
  /** Deve retornar somente staff ativo (admin | recruiter | community_manager). */
  findByEmail(email: string): Promise<StaffRecord | null>;
}

interface AuditEmitter {
  emit(event: McpAuditEvent): void;
}

interface Deps {
  tokens: OAuthTokenService;
  staffLookup: StaffLookup;
  auditor: AuditEmitter;
  /** Injetável em teste; default: admin.auth().verifyIdToken */
  verifyIdToken?: (idToken: string) => Promise<admin.auth.DecodedIdToken>;
}

const consentBodySchema = z.object({
  idToken: z.string().min(1),
  requestContext: z.string().min(1),
});

/**
 * POST /oauth/consent — recebe o idToken do Firebase (Google sign-in da
 * página de consent) + o request context assinado do /authorize. Autoriza
 * SOMENTE staff ativo (mesmo gate do painel admin, via tabela users) e
 * devolve a redirect URL com o authorization code.
 */
export function createConsentRoutes(deps: Deps): Router {
  const router = Router();
  const verifyIdToken =
    deps.verifyIdToken ?? ((idToken: string) => admin.auth().verifyIdToken(idToken));

  router.post('/consent', async (req: Request, res: Response): Promise<void> => {
    const start = Date.now();
    const audit = (outcome: 'success' | 'error', principal: string, errorMessage?: string) => {
      deps.auditor.emit({
        timestamp: new Date().toISOString(),
        principal,
        onBehalfOfWorkerId: null,
        capability: 'oauth.consent',
        argsRedacted: {},
        outcome,
        ...(errorMessage !== undefined ? { errorCode: 'CONSENT_DENIED', errorMessage } : {}),
        latencyMs: Date.now() - start,
      });
    };

    try {
      const body = consentBodySchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: 'idToken and requestContext are required' });
        return;
      }

      const ctx = deps.tokens.verifyConsentRequest(body.data.requestContext);
      if (!ctx) {
        res.status(400).json({ error: 'Solicitud expirada — volvé a intentar desde Claude' });
        return;
      }

      let decoded: admin.auth.DecodedIdToken;
      try {
        decoded = await verifyIdToken(body.data.idToken);
      } catch {
        audit('error', 'unknown', 'invalid firebase idToken');
        res.status(401).json({ error: 'Sesión de Google inválida' });
        return;
      }

      const email = decoded.email;
      if (!email || decoded.email_verified === false) {
        audit('error', email ?? 'unknown', 'email missing or unverified');
        res.status(403).json({ error: 'Cuenta sin email verificado' });
        return;
      }

      const staff = await deps.staffLookup.findByEmail(email);
      if (!staff) {
        audit('error', email, 'not an active staff member');
        res.status(403).json({ error: 'Tu cuenta no tiene acceso de staff en Enlite' });
        return;
      }

      const code = deps.tokens.signCode({
        clientId: ctx.clientId,
        redirectUri: ctx.redirectUri,
        codeChallenge: ctx.codeChallenge,
        scope: ctx.scope,
        email: staff.email,
        role: staff.role,
      });

      const redirectUrl = new URL(ctx.redirectUri);
      redirectUrl.searchParams.set('code', code);
      if (ctx.state !== undefined) {
        redirectUrl.searchParams.set('state', ctx.state);
      }

      audit('success', `claude-ai:${staff.email}`);
      res.json({ redirectUrl: redirectUrl.toString() });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      logger.error({ err: e }, 'mcp-oauth: unexpected error in consent');
      audit('error', 'unknown', e.message);
      res.status(500).json({ error: 'Error interno' });
    }
  });

  return router;
}
