/**
 * AccountLinkController — HTTP do vínculo self-service (contrato v2).
 *
 * Erros SEMPRE por código estável (o front decide por código, nunca por
 * mensagem). AccountLinkError → HTTP: NO_CONFLICT/USE_CLAIM 409 (o front
 * decide o caminho), RATE_LIMITED 429, OTP 400, token 401, not found 404.
 */

import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { logger, reportError } from '@shared/logging';
import { AccountLinkService } from './AccountLinkService';
import { AccountLinkError, type AccountLinkErrorCode } from './AccountLinkTypes';
import { verifyLinkToken } from './linkToken';
import { UndoMergeUseCase } from '../../application/dedup/UndoMergeUseCase';
import { recordAccountLinkEvent } from './accountLinkEvents';

const log = () => logger.child({ source: 'AccountLinkController' });

const ERROR_HTTP: Record<AccountLinkErrorCode, number> = {
  NO_CONFLICT: 409,
  USE_CLAIM: 409,
  RATE_LIMITED: 429,
  INVALID_OTP: 400,
  EXPIRED_OTP: 400,
  INVALID_LINK_TOKEN: 401,
  WORKER_NOT_FOUND: 404,
};

export class AccountLinkController {
  private readonly service: AccountLinkService;

  constructor(private readonly pool: Pool, service?: AccountLinkService) {
    this.service = service ?? new AccountLinkService(pool);
  }

  private authUid(req: Request): string | null {
    return ((req as { user?: { uid?: string } }).user?.uid
      ?? (req.headers['x-auth-uid'] as string | undefined)) || null;
  }

  private fail(res: Response, err: unknown, fallbackSource: string): void {
    if (err instanceof AccountLinkError) {
      res.status(ERROR_HTTP[err.code]).json({ success: false, code: err.code, error: err.code });
      return;
    }
    const e = err instanceof Error ? err : new Error(String(err));
    reportError(e, { source: fallbackSource });
    res.status(500).json({ success: false, error: 'Internal error' });
  }

  async lookup(req: Request, res: Response): Promise<void> {
    const uid = this.authUid(req);
    if (!uid) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
    try {
      const data = await this.service.lookup(uid, String(req.body?.phone ?? ''));
      res.status(200).json({ success: true, data });
    } catch (err) { this.fail(res, err, 'AccountLinkController:lookup'); }
  }

  async start(req: Request, res: Response): Promise<void> {
    const uid = this.authUid(req);
    if (!uid) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
    try {
      const data = await this.service.start(uid, String(req.body?.phone ?? ''));
      res.status(200).json({ success: true, data });
    } catch (err) { this.fail(res, err, 'AccountLinkController:start'); }
  }

  async confirm(req: Request, res: Response): Promise<void> {
    const uid = this.authUid(req);
    if (!uid) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
    const { phone, verificationSid, otp } = req.body ?? {};
    if (!verificationSid || !otp) {
      res.status(400).json({ success: false, error: 'Missing verificationSid/otp' });
      return;
    }
    try {
      const data = await this.service.confirm(uid, String(phone ?? ''), String(verificationSid), String(otp));
      res.status(200).json({ success: true, data });
    } catch (err) { this.fail(res, err, 'AccountLinkController:confirm'); }
  }

  async finalize(req: Request, res: Response): Promise<void> {
    const uid = this.authUid(req);
    if (!uid) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
    const { linkToken, fieldChoices } = req.body ?? {};
    const payload = linkToken ? verifyLinkToken(String(linkToken), 'finalize') : null;
    if (!payload) {
      res.status(401).json({ success: false, code: 'INVALID_LINK_TOKEN', error: 'INVALID_LINK_TOKEN' });
      return;
    }
    try {
      const data = await this.service.finalize(uid, payload, fieldChoices);
      res.status(200).json({ success: true, data });
    } catch (err) { this.fail(res, err, 'AccountLinkController:finalize'); }
  }

  // ── Undo público (link assinado do email — a credencial é o token) ───────

  /** GET: página mínima de confirmação (funciona direto do clique no email). */
  undoPage(req: Request, res: Response): void {
    const token = String(req.params.token ?? '');
    const payload = verifyLinkToken(token, 'undo');
    if (!payload) {
      res.status(410).send(undoHtml('El enlace expiró o no es válido.', null));
      return;
    }
    res.status(200).send(undoHtml(null, token));
  }

  async undoExecute(req: Request, res: Response): Promise<void> {
    const token = String(req.params.token ?? '');
    const payload = verifyLinkToken(token, 'undo');
    if (!payload || payload.mergeAuditId == null) {
      res.status(410).json({ success: false, error: 'Invalid or expired token' });
      return;
    }
    try {
      const undo = new UndoMergeUseCase(this.pool);
      const result = await undo.execute(payload.mergeAuditId, { undoneBy: 'account_link_email' });
      await recordAccountLinkEvent(this.pool, {
        event: 'undone',
        workerId: payload.survivorId,
        otherWorkerId: payload.absorbedId,
        mergeAuditId: payload.mergeAuditId,
        detail: { alreadyUndone: result.alreadyUndone },
      });
      log().info({ msg: 'account_link_undo_via_email', mergeAuditId: payload.mergeAuditId });
      res.status(200).json({ success: true, data: { alreadyUndone: result.alreadyUndone } });
    } catch (err) { this.fail(res, err, 'AccountLinkController:undoExecute'); }
  }
}

/** Página auto-contida (es-AR) servida pela API — sem depender do frontend. */
function undoHtml(error: string | null, token: string | null): string {
  const body = error
    ? `<p>${error}</p><p>Si necesitás ayuda, escribinos por WhatsApp.</p>`
    : `
      <p>Vas a revertir el vínculo de cuentas. Tu cuenta vuelve al estado exacto
      del momento del vínculo (postulaciones y documentos incluidos).</p>
      <button id="go">No fui yo — revertir vínculo</button>
      <p id="out"></p>
      <script>
        document.getElementById('go').addEventListener('click', async () => {
          const btn = document.getElementById('go');
          btn.disabled = true;
          const res = await fetch('/api/account-link/undo/${token}', { method: 'POST' });
          document.getElementById('out').textContent = res.ok
            ? 'Listo. El vínculo fue revertido y tu cuenta fue restaurada.'
            : 'No pudimos revertir. El enlace puede haber expirado — contactá al soporte.';
        });
      </script>`;
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Enlite — revertir vínculo</title>
<style>
  body{font-family:Arial,sans-serif;background:#FFF9FC;margin:0;padding:24px;display:flex;justify-content:center}
  main{max-width:480px;background:#fff;border-radius:12px;padding:32px;box-shadow:0 2px 12px rgba(24,1,73,.08)}
  h1{color:#180149;font-size:20px}
  button{background:#180149;color:#fff;border:0;border-radius:8px;padding:14px 28px;font-size:15px;cursor:pointer}
  button:disabled{opacity:.6}
</style></head><body><main><h1>Revertir vínculo de cuentas</h1>${body}</main></body></html>`;
}
