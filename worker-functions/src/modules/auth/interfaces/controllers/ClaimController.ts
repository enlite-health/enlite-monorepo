import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { logger } from '@shared/logging';
import { StartClaimUseCase } from '../../application/StartClaimUseCase';
import { ConfirmClaimUseCase } from '../../application/ConfirmClaimUseCase';
import { ResolveClaimTarget } from '../../application/ResolveClaimTarget';

type TokenUser = { uid?: string; email?: string };

/**
 * H3 (D650): identidade SÓ do token (`requireAuth` popula `req.user`). Devolve a identidade
 * ou já responde 401 (sem token) / 403 (body com authUid de outra identidade) e devolve null.
 */
export function identidadeDoToken(req: Request, res: Response): { authUid: string; email: string } | null {
  const user = (req as Request & { user?: TokenUser }).user;
  if (!user?.uid) {
    res.status(401).json({ success: false, error: 'Authentication required' });
    return null;
  }
  const bodyUid = (req.body as Record<string, unknown> | undefined)?.authUid;
  if (bodyUid !== undefined && bodyUid !== user.uid) {
    res.status(403).json({ success: false, error: 'authUid does not match authenticated user' });
    return null;
  }
  if (!user.email) {
    res.status(400).json({ success: false, error: 'Authenticated token has no email' });
    return null;
  }
  return { authUid: user.uid, email: user.email };
}

/**
 * ClaimController — endpoints para claim de ficha importada via OTP SMS.
 *
 * POST /api/auth/claim/start   — detecta candidato e dispara OTP
 * POST /api/auth/claim/confirm — valida OTP e executa a transferência de ficha
 */
export class ClaimController {
  constructor(
    private readonly startClaim: StartClaimUseCase,
    private readonly confirmClaim: ConfirmClaimUseCase,
    private readonly resolveTarget: ResolveClaimTarget,
  ) {}

  async start(req: Request, res: Response): Promise<void> {
    const requestId = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
    const startedAt = Date.now();

    const log = logger.child({
      source: 'ClaimController:start',
      requestId,
      ip: req.ip,
      userAgent: ((req.headers['user-agent'] as string | undefined) ?? '').slice(0, 100),
    });

    log.info({ msg: 'claim_request_received' });

    try {
      const identidade = identidadeDoToken(req, res);
      if (!identidade) {
        log.info({ msg: 'claim_request_completed', responseStatus: res.statusCode ?? null, durationMs: Date.now() - startedAt });
        return;
      }
      const { authUid, email } = identidade;
      const { phone } = req.body as Record<string, unknown>;

      if (!phone || typeof phone !== 'string') {
        res.status(400).json({ success: false, error: 'Missing required field: phone' });
        log.info({ msg: 'claim_request_completed', responseStatus: 400, durationMs: Date.now() - startedAt });
        return;
      }

      const result = await this.startClaim.execute({ authUid, email, phone });

      if (result.isFailure) {
        const error = result.error!;

        if (error === 'INVALID_PHONE') {
          res.status(400).json({ success: false, error });
          log.info({ msg: 'claim_request_completed', responseStatus: 400, durationMs: Date.now() - startedAt });
          return;
        }

        if (error === 'PHONE_COUNTRY_NOT_SUPPORTED') {
          res.status(400).json({ success: false, error, code: error });
          log.info({ msg: 'claim_request_completed', responseStatus: 400, durationMs: Date.now() - startedAt });
          return;
        }

        if (error === 'RATE_LIMITED' || error === 'OTP_CHANNEL_UNAVAILABLE') {
          const status = error === 'RATE_LIMITED' ? 429 : 503;
          res.status(status).json({ success: false, error, code: error });
          log.info({ msg: 'claim_request_completed', responseStatus: status, durationMs: Date.now() - startedAt });
          return;
        }

        log.warn({ msg: 'start_claim_error', error });
        res.status(500).json({ success: false, error: 'Internal server error' });
        log.info({ msg: 'claim_request_completed', responseStatus: 500, durationMs: Date.now() - startedAt });
        return;
      }

      res.status(200).json({ success: true, data: result.getValue() });
      log.info({ msg: 'claim_request_completed', responseStatus: 200, durationMs: Date.now() - startedAt });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      log.error({ msg: 'start_claim_unexpected', error: e.message });
      res.status(500).json({ success: false, error: 'Internal server error' });
      log.info({ msg: 'claim_request_completed', responseStatus: 500, durationMs: Date.now() - startedAt });
    }
  }

  async confirm(req: Request, res: Response): Promise<void> {
    const requestId = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
    const startedAt = Date.now();

    const log = logger.child({
      source: 'ClaimController:confirm',
      requestId,
      ip: req.ip,
      userAgent: ((req.headers['user-agent'] as string | undefined) ?? '').slice(0, 100),
    });

    log.info({ msg: 'claim_request_received' });

    try {
      const identidade = identidadeDoToken(req, res);
      if (!identidade) {
        log.info({ msg: 'claim_request_completed', responseStatus: res.statusCode ?? null, durationMs: Date.now() - startedAt });
        return;
      }
      const { authUid, email } = identidade;
      // `candidateWorkerId` no corpo (SPA em cache) é IGNORADO: a ficha sai do desafio deste uid.
      const { verificationSid, otp, lgpdOptIn } = req.body as Record<string, unknown>;

      if (!verificationSid || typeof verificationSid !== 'string') {
        res.status(400).json({ success: false, error: 'Missing required field: verificationSid' });
        log.info({ msg: 'claim_request_completed', responseStatus: 400, durationMs: Date.now() - startedAt });
        return;
      }
      if (!otp || typeof otp !== 'string') {
        res.status(400).json({ success: false, error: 'Missing required field: otp' });
        log.info({ msg: 'claim_request_completed', responseStatus: 400, durationMs: Date.now() - startedAt });
        return;
      }

      const candidateWorkerId = await this.resolveTarget.execute({ challengeId: verificationSid, requesterUid: authUid });
      if (!candidateWorkerId) {
        res.status(400).json({ success: false, error: 'CANDIDATE_NOT_FOUND' });
        log.info({ msg: 'claim_request_completed', responseStatus: 400, durationMs: Date.now() - startedAt });
        return;
      }

      const result = await this.confirmClaim.execute({
        verificationSid,
        otp,
        authUid,
        email,
        candidateWorkerId,
        // O OTP prova a posse do telefone, NÃO o aceite: só grava o trio se a caixa foi marcada (web: `lgpdOptIn`, como no init).
        consentAt: lgpdOptIn === true ? new Date() : undefined,
      });

      if (result.isFailure) {
        const error = result.error!;

        const clientErrors = new Set([
          'INVALID_OTP',
          'EXPIRED_OTP',
          'OTP_ALREADY_USED',
          'CANDIDATE_NOT_FOUND',
          'NOT_IMPORTABLE',
        ]);

        if (error === 'CLAIM_CONFLICT') {
          // D764: a conta já tem uma ficha com conteúdo; nada foi gravado. Só o `code` sai.
          res.status(409).json({ success: false, error, code: error });
          log.info({ msg: 'claim_request_completed', responseStatus: 409, durationMs: Date.now() - startedAt });
          return;
        }

        if (clientErrors.has(error)) {
          res.status(400).json({ success: false, error });
          log.info({ msg: 'claim_request_completed', responseStatus: 400, durationMs: Date.now() - startedAt });
          return;
        }

        log.warn({ msg: 'confirm_claim_error', error });
        res.status(500).json({ success: false, error: 'Internal server error' });
        log.info({ msg: 'claim_request_completed', responseStatus: 500, durationMs: Date.now() - startedAt });
        return;
      }

      res.status(200).json({ success: true, data: { worker: result.getValue() } });
      log.info({ msg: 'claim_request_completed', responseStatus: 200, durationMs: Date.now() - startedAt });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      log.error({ msg: 'confirm_claim_unexpected', error: e.message });
      res.status(500).json({ success: false, error: 'Internal server error' });
      log.info({ msg: 'claim_request_completed', responseStatus: 500, durationMs: Date.now() - startedAt });
    }
  }
}
