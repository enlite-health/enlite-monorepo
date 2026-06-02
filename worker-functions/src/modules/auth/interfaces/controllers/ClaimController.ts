import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { logger } from '@shared/logging';
import { StartClaimUseCase } from '../../application/StartClaimUseCase';
import { ConfirmClaimUseCase } from '../../application/ConfirmClaimUseCase';

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
      const { authUid, email, phone } = req.body as Record<string, unknown>;

      if (!authUid || typeof authUid !== 'string') {
        res.status(400).json({ success: false, error: 'Missing required field: authUid' });
        log.info({ msg: 'claim_request_completed', responseStatus: 400, durationMs: Date.now() - startedAt });
        return;
      }
      if (!email || typeof email !== 'string') {
        res.status(400).json({ success: false, error: 'Missing required field: email' });
        log.info({ msg: 'claim_request_completed', responseStatus: 400, durationMs: Date.now() - startedAt });
        return;
      }
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
      const { verificationSid, otp, authUid, email, candidateWorkerId } =
        req.body as Record<string, unknown>;

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
      if (!authUid || typeof authUid !== 'string') {
        res.status(400).json({ success: false, error: 'Missing required field: authUid' });
        log.info({ msg: 'claim_request_completed', responseStatus: 400, durationMs: Date.now() - startedAt });
        return;
      }
      if (!email || typeof email !== 'string') {
        res.status(400).json({ success: false, error: 'Missing required field: email' });
        log.info({ msg: 'claim_request_completed', responseStatus: 400, durationMs: Date.now() - startedAt });
        return;
      }
      if (!candidateWorkerId || typeof candidateWorkerId !== 'string') {
        res.status(400).json({ success: false, error: 'Missing required field: candidateWorkerId' });
        log.info({ msg: 'claim_request_completed', responseStatus: 400, durationMs: Date.now() - startedAt });
        return;
      }

      const result = await this.confirmClaim.execute({
        verificationSid,
        otp,
        authUid,
        email,
        candidateWorkerId,
      });

      if (result.isFailure) {
        const error = result.error!;

        const clientErrors = new Set([
          'INVALID_OTP',
          'EXPIRED_OTP',
          'CANDIDATE_NOT_FOUND',
          'NOT_IMPORTABLE',
        ]);

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
