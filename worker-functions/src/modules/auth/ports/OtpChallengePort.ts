import type { OtpSendContext } from '../infrastructure/TwilioVerifyService';

/**
 * Port do OTP próprio (D758). Quem confirma claim/link fala com ESTE port; o domínio e a aplicação não importam
 * Twilio nem Postgres. Adapters: `PgOtpChallengeService` (código nosso, template de autenticação) e, como plano B de
 * canal, o `TwilioVerifyService`.
 *
 * Finalidade: lista FECHADA no banco (CHECK em `otp_challenges.purpose`); estendê-la é ALTER de CHECK, sem migration
 * destrutiva. Este tipo e o CHECK andam juntos.
 */
export type OtpPurpose = 'claim' | 'link' | 'phone_verify';

/** O envio pelo canal falhou. Sem 2º canal (D732): quem chama mostra "tente de novo", nunca cai em SMS. */
export const OTP_CHANNEL_UNAVAILABLE = 'OTP_CHANNEL_UNAVAILABLE';

export type OtpCheckFailure = 'INVALID_OTP' | 'EXPIRED_OTP' | 'OTP_ALREADY_USED';

export type OtpCheckOutcome = { ok: true } | { ok: false; code: OtpCheckFailure };

export interface OtpStartInput {
  workerId: string;
  purpose: OtpPurpose;
  /** Telefone para o qual o código é emitido (E.164). */
  phoneE164: string;
  /** Fatos da guarda de ficha de teste (FR-95): o envio é suprimido quando as duas condições valem. */
  ctx?: OtpSendContext;
}

export interface OtpCheckInput {
  /** Id devolvido pelo `start`. */
  challengeId: string;
  workerId: string;
  /** Telefone GRAVADO na ficha, lido do banco — nunca o que o cliente manda (DP-21). */
  phoneOnRecord: string;
  code: string;
}

export interface OtpChallengePort {
  /** Cancela o pendente da mesma ficha e finalidade, grava o novo (só o HMAC) e envia. Falha de canal → `OTP_CHANNEL_UNAVAILABLE`. */
  start(input: OtpStartInput): Promise<{ challengeId: string }>;
  /** Consome o desafio de forma atômica: o mesmo código nunca vale duas vezes. */
  check(input: OtpCheckInput): Promise<OtpCheckOutcome>;
  /** Cancela o pendente da ficha para a finalidade (sem efeito se não houver). */
  cancel(input: { workerId: string; purpose: OtpPurpose }): Promise<void>;
}
