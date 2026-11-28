import { Worker } from './Worker';

/**
 * Discriminated union returned by InitWorkerUseCase.
 *
 *   status: 'ok'           — worker criado ou reconciliado por email; pode prosseguir.
 *   status: 'claim_pending' — phone bateu em ficha importada; OTP foi disparado via
 *                            Twilio Verify; claim deve ser confirmado antes de qualquer
 *                            operação no banco.
 *   status: 'not_registered' — chamada do app (canal app) sem ficha: nada foi criado (D734).
 *   `code` (FR-88/C-43): só no ramo de telefone de worker existente — OK, PHONE_LOCKED (status ok),
 *   CLAIM_PENDING (claim_pending) e PHONE_IN_USE / INVALID_PHONE (status phone_rejected).
 */
export type InitWorkerOutput =
  | { status: 'ok'; worker: Worker; code?: 'OK' | 'PHONE_LOCKED' }
  | {
      status: 'claim_pending';
      phoneMasked: string;
      verificationSid: string;
      code?: 'CLAIM_PENDING';
    }
  | { status: 'not_registered' }
  | { status: 'phone_rejected'; code: 'PHONE_IN_USE' | 'INVALID_PHONE' };
