import twilio from 'twilio';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { IsTestOtpGuardedVerify } from '@modules/auth/application/IsTestOtpGuard';
import { PgOtpChallengeService } from '@modules/auth/infrastructure/PgOtpChallengeService';
import { TwilioAuthTemplateSender } from '@modules/auth/infrastructure/TwilioAuthTemplateSender';
import { TwilioVerifyOtpAdapter } from '@modules/auth/infrastructure/TwilioVerifyOtpAdapter';
import { TwilioVerifyService } from '@modules/auth/infrastructure/TwilioVerifyService';
import { lazyPool } from '@shared/db/lazyPool';
import { GuardedOtpChallengePort } from '@modules/auth/application/GuardedOtpChallengePort';
import { PgOtpSendLedger } from '@modules/auth/infrastructure/PgOtpSendLedger';
import type { OtpChallengePort } from '@modules/auth/ports/OtpChallengePort';

/** Teto global diário de envios de OTP (G2). Em Cloud Run (`K_SERVICE`) é OBRIGATÓRIO: ausente ou inválido derruba o boot —
 *  a revisão nova não sobe e a anterior segue servindo. Fora do Cloud Run (dev, jest), 1000. */
export function dailyMaxFrom(env: NodeJS.ProcessEnv): number {
  const raw = env.OTP_GLOBAL_DAILY_MAX;
  const n = raw === undefined ? NaN : Number(raw);
  if (Number.isInteger(n) && n > 0) return n;
  if (env.K_SERVICE) throw new Error('OTP_GLOBAL_DAILY_MAX must be a positive integer');
  return 1000;
}

/**
 * Ponto ÚNICO que escolhe o adapter do OTP (D758). Código próprio (`PgOtpChallengeService` + template de autenticação) quando o
 * template (`TWILIO_AUTH_TEMPLATE_CONTENT_SID`) e o pepper (`OTP_HMAC_PEPPER`) existem; senão, o plano B (Twilio Verify). Troca por
 * configuração, sem mudar chamador: claim, vínculo e verificação do celular falam só com o port. Os dois adapters saem
 * envoltos no `GuardedOtpChallengePort` (país AR/BR e teto diário, `OTP_GLOBAL_DAILY_MAX`).
 */
export function createOtpChallengePort(env: NodeJS.ProcessEnv = process.env): OtpChallengePort {
  const dailyMax = dailyMaxFrom(env);
  // Pool preguiçoso: montar o port no boot não abre conexão nem exige banco (no ramo Verify isso seria comportamento novo).
  const ledger = new PgOtpSendLedger(lazyPool());
  const contentSid = env.TWILIO_AUTH_TEMPLATE_CONTENT_SID;
  const accountSid = env.TWILIO_ACCOUNT_SID;
  const authToken = env.TWILIO_AUTH_TOKEN;
  if (contentSid && env.OTP_HMAC_PEPPER && accountSid && authToken) {
    const sender = new TwilioAuthTemplateSender(twilio(accountSid, authToken), {
      contentSid,
      fromNumber: env.TWILIO_WHATSAPP_NUMBER,
      messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID,
    });
    return new GuardedOtpChallengePort(new PgOtpChallengeService(DatabaseConnection.getInstance().getPool(), sender), ledger, 'own', dailyMax);
  }
  return new GuardedOtpChallengePort(
    new TwilioVerifyOtpAdapter(new IsTestOtpGuardedVerify(new TwilioVerifyService())), ledger, 'verify', dailyMax,
  );
}
