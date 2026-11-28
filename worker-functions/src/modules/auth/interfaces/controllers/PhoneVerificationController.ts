import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { logger } from '@shared/logging';
import { StartPhoneVerificationUseCase } from '../../application/StartPhoneVerificationUseCase';
import { ConfirmPhoneVerificationUseCase } from '../../application/ConfirmPhoneVerificationUseCase';
import { identidadeDoToken } from './ClaimController';

const STATUS_BY_CODE: Record<string, number> = {
  INVALID_PHONE: 400,
  PHONE_COUNTRY_NOT_SUPPORTED: 400,
  INVALID_CONSENT_AT: 400,
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
 * POST /api/workers/me/phone-verification/start   — corpo { phone } ou { challengeId }
 *   Sem `phone`, com `challengeId` de claim (D797 adendo 3): reenvio do código de claim para o número gravado no desafio (ou na ficha,
 *   plano B); o id alheio, inexistente ou que não é de claim → 400 CANDIDATE_NOT_FOUND. Com `phone`, um `challengeId` junto é ignorado.
 * POST /api/workers/me/phone-verification/confirm — corpo { phone?, challengeId, code, consentAcceptedAt? }
 *   `phone` só pode faltar quando o desafio é de claim (D797); no `phone_verify` o use case devolve INVALID_PHONE.
 *   `consentAcceptedAt` (ISO-8601): hora em que a caixa do aceite foi marcada; ver `resolveConsentAcceptedAt` para a janela.
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
      const challengeId = str(req.body, 'challengeId');
      if (!phone && !challengeId) {
        res.status(400).json({ success: false, error: 'Missing required field: phone or challengeId' });
        return;
      }
      const result = await this.startUseCase.execute(phone ? { ...identidade, phone } : { ...identidade, challengeId: challengeId! });
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
      // `phone` é opcional (D797): o caso do claim no cadastro só conhece o celular mascarado. Quem decide se pode faltar é o use case.
      if (!challengeId || !code) {
        res.status(400).json({ success: false, error: 'Missing required fields: challengeId, code' });
        return;
      }
      const rawConsentAt = (req.body as Record<string, unknown> | undefined)?.consentAcceptedAt;
      if (rawConsentAt !== undefined && typeof rawConsentAt !== 'string') {
        res.status(400).json({ success: false, error: 'INVALID_CONSENT_AT', code: 'INVALID_CONSENT_AT' });
        return;
      }
      const outcome = await this.confirmUseCase.execute({ ...identidade, ...(phone ? { phone } : {}), challengeId, code, consentAcceptedAt: rawConsentAt });
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
