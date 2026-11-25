import twilio from 'twilio';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { IsTestOtpGuardedVerify } from '@modules/auth/application/IsTestOtpGuard';
import { PgOtpChallengeService } from '@modules/auth/infrastructure/PgOtpChallengeService';
import { TwilioAuthTemplateSender } from '@modules/auth/infrastructure/TwilioAuthTemplateSender';
import { TwilioVerifyOtpAdapter } from '@modules/auth/infrastructure/TwilioVerifyOtpAdapter';
import { TwilioVerifyService } from '@modules/auth/infrastructure/TwilioVerifyService';
import type { OtpChallengePort } from '@modules/auth/ports/OtpChallengePort';

/**
 * Ponto ÚNICO que escolhe o adapter do OTP (D758). Código próprio (`PgOtpChallengeService` + template de autenticação) quando o
 * template (`TWILIO_AUTH_TEMPLATE_CONTENT_SID`) e o pepper (`OTP_HMAC_PEPPER`) existem; senão, o plano B (Twilio Verify). Troca por
 * configuração, sem mudar chamador: claim, vínculo e verificação do celular falam só com o port.
 */
export function createOtpChallengePort(env: NodeJS.ProcessEnv = process.env): OtpChallengePort {
  const contentSid = env.TWILIO_AUTH_TEMPLATE_CONTENT_SID;
  const accountSid = env.TWILIO_ACCOUNT_SID;
  const authToken = env.TWILIO_AUTH_TOKEN;
  if (contentSid && env.OTP_HMAC_PEPPER && accountSid && authToken) {
    const sender = new TwilioAuthTemplateSender(twilio(accountSid, authToken), {
      contentSid,
      fromNumber: env.TWILIO_WHATSAPP_NUMBER,
      messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID,
    });
    return new PgOtpChallengeService(DatabaseConnection.getInstance().getPool(), sender);
  }
  return new TwilioVerifyOtpAdapter(new IsTestOtpGuardedVerify(new TwilioVerifyService()));
}
