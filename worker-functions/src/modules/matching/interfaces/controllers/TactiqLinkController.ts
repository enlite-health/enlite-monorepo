import { Request, Response } from 'express';
import { z } from 'zod';
import { reportError } from '@shared/logging';
import { actorUid, MissingActorError } from '@modules/conversation/interfaces/controllers/ConversationActor';
import {
  TactiqExchangeFailedError,
  TactiqLinkService,
  TactiqStateInvalidError,
} from '../../application/TactiqLinkService';
import { TactiqNotConfiguredError } from '../../application/ports/TactiqPorts';

const callbackQuery = z.object({ code: z.string().min(1).max(2048), state: z.string().min(1).max(512) });

/**
 * TactiqLinkController — o operador vê e gerencia o PRÓPRIO vínculo (spec 049 F4).
 *
 *   GET  /me/tactiq-link            own_tactiq_link:read   estado do vínculo (SEM token, nunca)
 *   POST /me/tactiq-link            own_tactiq_link:create inicia o OAuth → { authorizeUrl }
 *   GET  /me/tactiq-link/callback   (sem Bearer)           o Tactiq redireciona o NAVEGADOR para cá
 *
 * O callback é uma navegação do browser: não carrega o header de autorização. A identidade vem do `state` (criado no
 * POST autenticado, ligado ao uid + e-mail, 10 min, uso único). `state` inválido → 400 e nada é gravado.
 *
 * Erro vira resposta com `code` estável; o resto, 500 genérico relatado só com a origem — nunca token, e-mail nem corpo.
 */
export class TactiqLinkController {
  constructor(private readonly service: TactiqLinkService) {}

  async getOwn(req: Request, res: Response): Promise<void> {
    await this.run(res, 'getOwn', async () => {
      const email = this.emailOf(req);
      if (!email) return this.noEmail(res);
      res.status(200).json({ success: true, data: await this.service.getOwn(email) });
    });
  }

  async start(req: Request, res: Response): Promise<void> {
    await this.run(res, 'start', async () => {
      const email = this.emailOf(req);
      if (!email) return this.noEmail(res);
      const out = await this.service.startLink({ uid: actorUid(req), email });
      res.status(200).json({ success: true, data: out });
    });
  }

  async callback(req: Request, res: Response): Promise<void> {
    const q = callbackQuery.safeParse(req.query);
    if (!q.success) {
      res.status(400).json({ success: false, error: 'Invalid callback', code: 'TACTIQ_CALLBACK_INVALID' });
      return;
    }
    try {
      await this.service.completeLink(q.data);
      this.finish(res, 'linked');
    } catch (err: unknown) {
      if (err instanceof TactiqStateInvalidError) {
        res.status(400).json({ success: false, error: err.message, code: err.code });
        return;
      }
      if (err instanceof TactiqExchangeFailedError) {
        this.finish(res, 'error', err.reason, 502, err.code);
        return;
      }
      reportError(err instanceof Error ? err : new Error(String(err)), { source: 'TactiqLinkController:callback' });
      this.finish(res, 'error', 'internal', 500, 'INTERNAL_ERROR');
    }
  }

  /** Volta o navegador para a tela do perfil (`TACTIQ_LINK_RETURN_URL`); sem a env, responde JSON (stack/teste). */
  private finish(res: Response, outcome: 'linked' | 'error', reason?: string, failStatus = 502, failCode = 'TACTIQ_EXCHANGE_FAILED'): void {
    const returnUrl = process.env.TACTIQ_LINK_RETURN_URL;
    if (returnUrl) {
      const url = new URL(returnUrl);
      url.searchParams.set('tactiq', outcome);
      if (reason) url.searchParams.set('reason', reason);
      res.redirect(302, url.toString());
      return;
    }
    if (outcome === 'linked') res.status(200).json({ success: true, data: { status: 'linked' } });
    else res.status(failStatus).json({ success: false, error: 'Tactiq link failed', code: failCode, reason });
  }

  private emailOf(req: Request): string | null {
    const email = (req as unknown as { user?: { email?: string | null } }).user?.email;
    return email ? email.toLowerCase() : null;
  }

  private noEmail(res: Response): void {
    res.status(400).json({ success: false, error: 'Authenticated user has no e-mail', code: 'NO_EMAIL' });
  }

  private async run(res: Response, source: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err: unknown) {
      if (err instanceof MissingActorError) {
        res.status(401).json({ success: false, error: err.message, code: err.code });
        return;
      }
      if (err instanceof TactiqNotConfiguredError) {
        res.status(503).json({ success: false, error: 'Tactiq link unavailable', code: err.code });
        return;
      }
      reportError(err instanceof Error ? err : new Error(String(err)), { source: `TactiqLinkController:${source}` });
      res.status(500).json({ success: false, error: 'Internal error' });
    }
  }
}
