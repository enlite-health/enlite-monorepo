import type { OtpChallengePort, OtpCheckInput, OtpCheckOutcome, OtpStartInput } from '../ports/OtpChallengePort';
import { otpCheckIsForPhone, type ITwilioVerifyService } from './TwilioVerifyService';

/**
 * PLANO B de canal (D758): o `OtpChallengePort` sobre o Twilio Verify. Só entra quando o template de autenticação próprio ainda
 * não está configurado (ver `createOtpChallengePort`). O código mora na Twilio: `challengeId` aqui é o `verificationSid`, não há
 * linha em `otp_challenges` e portanto nenhum limite por telefone/ficha no banco (o limite por IP segue no controller).
 * A guarda de ficha de teste (FR-95) decora o `ITwilioVerifyService` recebido (`IsTestOtpGuardedVerify`).
 */
export class TwilioVerifyOtpAdapter implements OtpChallengePort {
  constructor(private readonly verify: ITwilioVerifyService) {}

  async start(input: OtpStartInput): Promise<{ challengeId: string }> {
    const { verificationSid } = await this.verify.startVerification(input.phoneE164, input.ctx);
    return { challengeId: verificationSid };
  }

  async check(input: OtpCheckInput): Promise<OtpCheckOutcome> {
    const check = await this.verify.checkVerification(input.challengeId, input.code, input.ctx);
    if (!check.valid) {
      return { ok: false, code: check.status === 'expired' || check.status === 'canceled' ? 'EXPIRED_OTP' : 'INVALID_OTP' };
    }
    // DP-21: o código tem de ter ido ao telefone GRAVADO na ficha (`to` do Twilio), nunca ao que o cliente mandou.
    if (!otpCheckIsForPhone(check, input.phoneOnRecord)) return { ok: false, code: 'INVALID_OTP' };
    return { ok: true };
  }

  async cancel(): Promise<void> {
    // Nada a cancelar: o Verify expira sozinho.
  }
}
