import type { OtpConfirmContext, OtpSendContext } from '../infrastructure/TwilioVerifyService';

/**
 * Port do OTP próprio (D758). Quem confirma claim/link fala com ESTE port; o domínio e a aplicação não importam
 * Twilio nem Postgres. Adapters: `PgOtpChallengeService` (código nosso, template de autenticação) e, como plano B de
 * canal, o `TwilioVerifyService`.
 *
 * Finalidade: lista FECHADA no banco (CHECK em `otp_challenges.purpose`); estendê-la é ALTER de CHECK, sem migration
 * destrutiva. Este tipo e o CHECK andam juntos.
 */
export type OtpPurpose = 'claim' | 'link' | 'phone_verify';

/** Validade do código (a mesma do Verify), em minutos. Um dono só: o adapter expira com ela e quem responde ao app informa. */
export const OTP_TTL_MINUTES = 10;

/** O envio pelo canal falhou. Sem 2º canal (D732): quem chama mostra "tente de novo", nunca cai em SMS. */
export const OTP_CHANNEL_UNAVAILABLE = 'OTP_CHANNEL_UNAVAILABLE';

/** Limite de envio de código estourado (por telefone ou por ficha, contado no banco). Quem chama mapeia para 429 `RATE_LIMITED`. */
export const OTP_RATE_LIMITED = 'RATE_LIMITED';

/** Telefone fora dos países atendidos (só celular AR +54 e BR +55). Quem chama mapeia para 400 com `code`. */
export const OTP_COUNTRY_NOT_SUPPORTED = 'PHONE_COUNTRY_NOT_SUPPORTED';

/** Recusas de envio que o chamador traduz para o cliente (os demais erros do `start` são falha de canal). */
export const OTP_START_REFUSALS = [OTP_RATE_LIMITED, OTP_CHANNEL_UNAVAILABLE, OTP_COUNTRY_NOT_SUPPORTED] as const;

export const isOtpStartRefusal = (m: string): boolean => (OTP_START_REFUSALS as readonly string[]).includes(m);

export type OtpCheckFailure = 'INVALID_OTP' | 'EXPIRED_OTP' | 'OTP_ALREADY_USED';

export type OtpCheckOutcome = { ok: true } | { ok: false; code: OtpCheckFailure };

export interface OtpStartInput {
  workerId: string;
  purpose: OtpPurpose;
  /** Telefone para o qual o código é emitido (E.164). */
  phoneE164: string;
  /** Fatos da guarda de ficha de teste (FR-95): o envio é suprimido quando as duas condições valem. */
  ctx?: OtpSendContext;
  /** uid do TOKEN de quem pediu o envio (não da ficha). Vai ao registro de envio como sha256; nunca a log. */
  requesterUid: string;
}

export interface OtpCheckInput {
  /** Id devolvido pelo `start`. */
  challengeId: string;
  workerId: string;
  /** Finalidade do desafio que está sendo conferido: código de `link` não confirma `claim`. O adapter do Verify ignora. */
  purpose: OtpPurpose;
  /** Telefone GRAVADO na ficha, lido do banco — nunca o que o cliente manda (DP-21). */
  phoneOnRecord: string;
  code: string;
  /** Fatos da guarda de ficha de teste para o CONFIRM. Só o plano B (Twilio Verify) os usa; o adapter próprio decide no `start`. */
  ctx?: OtpConfirmContext;
}

export interface OtpChallengePort {
  /** Cancela o pendente da mesma ficha e finalidade, grava o novo (só o HMAC) e envia. Falha de canal → `OTP_CHANNEL_UNAVAILABLE`; limite por telefone/ficha estourado → `RATE_LIMITED` (nada é cancelado, gravado nem enviado). */
  start(input: OtpStartInput): Promise<{ challengeId: string }>;
  /** Consome o desafio de forma atômica: o mesmo código nunca vale duas vezes. */
  check(input: OtpCheckInput): Promise<OtpCheckOutcome>;
  /** Cancela o pendente da ficha para a finalidade (sem efeito se não houver). */
  cancel(input: { workerId: string; purpose: OtpPurpose }): Promise<void>;
}
