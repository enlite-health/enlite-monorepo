import { Worker } from './Worker';

/**
 * Discriminated union returned by InitWorkerUseCase.
 *
 *   status: 'ok'           — worker criado ou reconciliado por email; pode prosseguir.
 *   status: 'claim_pending' — phone bateu em ficha importada; OTP foi disparado via
 *                            Twilio Verify; claim deve ser confirmado antes de qualquer
 *                            operação no banco.
 *   status: 'not_registered' — chamada do app (canal app) sem ficha: nada foi criado (D734).
 */
export type InitWorkerOutput =
  | { status: 'ok'; worker: Worker }
  | {
      status: 'claim_pending';
      candidateWorkerId: string;
      phoneMasked: string;
      verificationSid: string;
    }
  | { status: 'not_registered' };
