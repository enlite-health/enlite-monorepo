import { ContractedServiceApiError } from '@infrastructure/http/AdminContractedServicesApiService';

/**
 * A régua ÚNICA de erro das ações sobre o serviço contratado — quadro C (`useServiceTeam`) e aba
 * "Itinerario" (`usePatientItinerary`); fonte única desde o G2 do gate fecho da Fase 12 (antes, cada
 * hook reescrevia a mesma régua): 403 → `forbidden`; erro da API com `code` (409/422) → `coded`,
 * com o erro original (o 409 `ITINERARY_OVERLAP` carrega `overlap`); qualquer outro → `error`.
 */
export type ContractedServiceActionError =
  | { kind: 'forbidden' }
  | { kind: 'coded'; code: string; error: ContractedServiceApiError }
  | { kind: 'error' };

export function isForbiddenError(err: unknown): boolean {
  return err instanceof ContractedServiceApiError && err.status === 403;
}

export function classifyActionError(err: unknown): ContractedServiceActionError {
  if (isForbiddenError(err)) return { kind: 'forbidden' };
  if (err instanceof ContractedServiceApiError && err.code) return { kind: 'coded', code: err.code, error: err };
  return { kind: 'error' };
}
