import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { logger } from '@shared/logging';
import { StartPhoneVerificationUseCase } from '../../application/StartPhoneVerificationUseCase';
import { ConfirmPhoneVerificationUseCase } from '../../application/ConfirmPhoneVerificationUseCase';
import { identidadeDoToken } from './ClaimController';

const STATUS_BY_CODE: Record<string, number> = {
  INVALID_PHONE: 400,
  INVALID_OTP: 400,
  EXPIRED_OTP: 400,
  OTP_ALREADY_USED: 400,
  CANDIDATE_NOT_FOUND: 400,
  NOT_IMPORTABLE: 400,
  WORKER_NOT_FOUND: 404,
  PHONE_IN_USE: 409,
  CLAIM_CONFLICT: 409,
  RATE_LIMITED: 429,
  OTP_CHANNEL_UNAVAILABLE: 503,
};

function str(body: unknown, key: string): string | null {
  const v = (body as Record<string, unknown> | undefined)?.[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Celular verificado (emenda 077 §2.4). Identidade SÓ do token (`requireAuth`). A finalidade NUNCA vem do corpo: um `purpose`
 * enviado é ignorado. Log: só `code` e status; nada de telefone, código ou nome (AC-8).
 *
 * POST /api/workers/me/phone-verification/start   — corpo { phone }
 * POST /api/workers/me/phone-verification/confirm — corpo { phone, challengeId, code }
 */
export class PhoneVerificationController {
  constructor(
    private readonly startUseCase: StartPhoneVerificationUseCase,
    private readonly confirmUseCase: ConfirmPhoneVerificationUseCase,
  ) {}

  async start(req: Request, res: Response): Promise<void> {
    const log = logger.child({ source: 'PhoneVerificationController:start', requestId: (req.headers['x-request-id'] as string | undefined) ?? randomUUID() });
    try {
      const identidade = identidadeDoToken(req, res);
      if (!identidade) return;
      const phone = str(req.body, 'phone');
      if (!phone) {
        res.status(400).json({ success: false, error: 'Missing required field: phone' });
        return;
      }
      const result = await this.startUseCase.execute({ ...identidade, phone });
      if (result.isFailure) {
        const code = result.error!;
        const status = STATUS_BY_CODE[code] ?? 500;
        if (status === 500) log.warn({ msg: 'phone_verification_start_error', code });
        res.status(status).json(status === 500 ? { success: false, error: 'Internal server error' } : { success: false, error: code, code });
        return;
      }
      res.status(200).json({ success: true, data: result.getValue() });
    } catch {
      log.error({ msg: 'phone_verification_start_unexpected' });
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  async confirm(req: Request, res: Response): Promise<void> {
    const log = logger.child({ source: 'PhoneVerificationController:confirm', requestId: (req.headers['x-request-id'] as string | undefined) ?? randomUUID() });
    try {
      const identidade = identidadeDoToken(req, res);
      if (!identidade) return;
      const phone = str(req.body, 'phone');
      const challengeId = str(req.body, 'challengeId');
      const code = str(req.body, 'code');
      if (!phone || !challengeId || !code) {
        res.status(400).json({ success: false, error: 'Missing required fields: phone, challengeId, code' });
        return;
      }
      const outcome = await this.confirmUseCase.execute({ ...identidade, phone, challengeId, code });
      if (!outcome.ok) {
        const status = STATUS_BY_CODE[outcome.code] ?? 500;
        if (status === 500) {
          log.warn({ msg: 'phone_verification_confirm_error', code: outcome.code });
          res.status(500).json({ success: false, error: 'Internal server error' });
          return;
        }
        res.status(status).json({ success: false, error: outcome.code, code: outcome.code, ...(outcome.handoffUrl ? { handoffUrl: outcome.handoffUrl } : {}) });
        return;
      }
      res.status(200).json({ success: true, data: { status: outcome.status, phoneMasked: outcome.phoneMasked, verifiedAt: outcome.verifiedAt.toISOString() } });
    } catch {
      log.error({ msg: 'phone_verification_confirm_unexpected' });
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }
}
