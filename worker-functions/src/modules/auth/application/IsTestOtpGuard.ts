import { isEnliteTestEmail } from '@shared/utils/testAccountEmail';
import type { OtpSendContext } from '../ports/OtpChallengePort';

/**
 * FR-95/DP-23: o OTP de ficha `is_test` não sai pelo Twilio.
 *
 * Suprime SÓ quando as DUAS condições valem: a ficha que recebe o código é `is_test` E o
 * e-mail do token é `@enlite.test`. Ficha real com token de teste, ou ficha de teste com token
 * real, seguem pelo envio normal — o atalho nunca vale para ficha de pessoa de verdade.
 */
export function shouldSuppressOtp(ctx?: OtpSendContext): boolean {
  if (ctx && ctx.fichaIsTest === true && isEnliteTestEmail(ctx.tokenEmail)) {
    return true;
  }
  return false;
}
