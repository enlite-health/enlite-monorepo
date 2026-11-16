/**
 * O que o `POST /api/workers/init` decidiu, num lugar só (DP-20). Quem chama o init (1º login,
 * cadastro, perfil) trata o resultado pelo MESMO `WorkerInitOutcomePanel`:
 *  - `ok`                 → segue (ficha criada, religada ou já existente);
 *  - `claim_pending`      → OTP foi ao telefone da ficha: abrir o `ClaimOtpModal`;
 *  - `email_not_verified` → a ficha do e-mail é de outro login e o token não prova o e-mail:
 *                           "Revisá tu correo" (reenviar link; depois, token novo + init de novo);
 *  - `rate_limited`       → 429 da cota de OTP do init: "esperá unos minutos".
 * Qualquer outro erro sobe como antes.
 */
import { ApiError } from '@infrastructure/http/ApiError';
import type { InitWorkerResponse } from '@infrastructure/http/WorkerApiService';

export type WorkerInitOutcome =
  | { kind: 'ok'; response: Extract<InitWorkerResponse, { status: 'ok' }> }
  | { kind: 'claim_pending'; candidateWorkerId: string; phoneMasked: string; verificationSid: string }
  | { kind: 'email_not_verified' }
  | { kind: 'rate_limited' };

export const EMAIL_NOT_VERIFIED = 'EMAIL_NOT_VERIFIED';

/** Tela do 1º login cujo init não deu `ok` (`WorkerAccountCheckPage`). */
export const WORKER_ACCOUNT_CHECK_ROUTE = '/cuenta/verificacion';

export async function runWorkerInit(call: () => Promise<InitWorkerResponse>): Promise<WorkerInitOutcome> {
  try {
    const response = await call();
    if (response.status === 'ok') return { kind: 'ok', response };
    const { candidateWorkerId, phoneMasked, verificationSid } = response;
    return { kind: 'claim_pending', candidateWorkerId, phoneMasked, verificationSid };
  } catch (err) {
    if (err instanceof ApiError && err.status === 429) return { kind: 'rate_limited' };
    if (err instanceof Error && err.message === EMAIL_NOT_VERIFIED) return { kind: 'email_not_verified' };
    throw err;
  }
}

/**
 * Passagem do 1º login para a tela de pendência: o `useAreaDestination` já chamou o init (e o
 * OTP já saiu); a tela lê o resultado daqui em vez de chamar o init de novo (que mandaria outro
 * SMS e gastaria a cota). Só memória: recarregar a página refaz o init.
 */
let pending: Exclude<WorkerInitOutcome, { kind: 'ok' }> | null = null;

export function handOffInitOutcome(outcome: Exclude<WorkerInitOutcome, { kind: 'ok' }>): void {
  pending = outcome;
}

export function takeInitOutcome(): Exclude<WorkerInitOutcome, { kind: 'ok' }> | null {
  const o = pending;
  pending = null;
  return o;
}
