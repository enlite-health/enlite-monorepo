import type { OtpPurpose } from './OtpChallengePort';

export interface OtpSendEvent {
  challengeId: string;
  adapter: 'own' | 'verify';
  purpose: OtpPurpose;
  /** uid do token que pediu o envio; o adapter grava sha256, nunca cru. */
  requesterUid: string;
  /** Só no adapter verify (CHECK da tabela). */
  targetWorkerId: string | null;
  /** FR-95: ficha de teste, nada saiu pelo Twilio. */
  suppressed: boolean;
}

export interface OtpSendLedgerPort {
  /** Envios NÃO suprimidos desde 00:00 de Buenos Aires. */
  sentToday(): Promise<number>;
  record(event: OtpSendEvent): Promise<void>;
  /** A ficha do desafio de claim pedido por ESTE uid nos últimos `withinMinutes`. own → otp_challenges.worker_id; verify → target_worker_id. */
  findClaimTarget(q: { challengeId: string; requesterUid: string; withinMinutes: number }): Promise<string | null>;
}
