import { logger, safeErrorFields } from '@shared/logging';
import { isAllowedOtpDestination } from '@shared/utils/phoneNormalization';
import {
  OTP_CHANNEL_UNAVAILABLE,
  OTP_COUNTRY_NOT_SUPPORTED,
  type OtpChallengePort,
  type OtpCheckInput,
  type OtpCheckOutcome,
  type OtpPurpose,
  type OtpStartInput,
} from '../ports/OtpChallengePort';
import type { OtpSendLedgerPort } from '../ports/OtpSendLedgerPort';
import { shouldSuppressOtp } from './IsTestOtpGuard';

/**
 * Decorator do OTP (G1, G2): barra destino fora de AR/BR e aplica o teto global diário de envios, em volta de QUALQUER
 * adapter (`own` ou `verify`), instalado no ponto único `createOtpChallengePort`. Não muda o contrato do port.
 * Ordem: conta → envia → grava, sem lock (na virada do teto passam no máximo os starts simultâneos). Falha ao gravar
 * depois do envio NÃO derruba (o código já saiu). Suprimido (FR-95) não conta no teto, mas é gravado.
 */
export class GuardedOtpChallengePort implements OtpChallengePort {
  constructor(
    private readonly inner: OtpChallengePort,
    private readonly ledger: OtpSendLedgerPort,
    private readonly adapter: 'own' | 'verify',
    private readonly dailyMax: number,
  ) {}

  async start(input: OtpStartInput): Promise<{ challengeId: string }> {
    if (!isAllowedOtpDestination(input.phoneE164)) throw new Error(OTP_COUNTRY_NOT_SUPPORTED);
    const suppressed = shouldSuppressOtp(input.ctx);
    if (!suppressed) {
      const sent = await this.ledger.sentToday();
      if (sent >= this.dailyMax) {
        logger.child({ source: 'GuardedOtpChallengePort:start' }).warn({ msg: 'otp_global_ceiling_reached', sent, dailyMax: this.dailyMax });
        throw new Error(OTP_CHANNEL_UNAVAILABLE);
      }
    }
    const out = await this.inner.start(input);
    try {
      await this.ledger.record({
        challengeId: out.challengeId,
        adapter: this.adapter,
        purpose: input.purpose,
        requesterUid: input.requesterUid,
        targetWorkerId: this.adapter === 'verify' ? input.workerId : null,
        suppressed,
      });
    } catch (err) {
      logger.child({ source: 'GuardedOtpChallengePort:start' }).warn({ msg: 'otp_send_event_record_failed', ...safeErrorFields(err) });
    }
    return out;
  }

  check(input: OtpCheckInput): Promise<OtpCheckOutcome> {
    return this.inner.check(input);
  }

  cancel(input: { workerId: string; purpose: OtpPurpose }): Promise<void> {
    return this.inner.cancel(input);
  }
}
