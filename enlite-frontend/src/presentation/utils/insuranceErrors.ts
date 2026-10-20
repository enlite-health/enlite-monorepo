/**
 * insuranceErrors — traduz o erro do mapa único do back (spec 058 §K, `insuranceErrorResponse.ts`) para o texto da tela.
 *
 * O back devolve `code` (um por regra: `REQUIRES_NEW_SERVICE`, `RANGE_OVERLAP`, `INVALID_<constraint>`...). A tela NUNCA mostra o `error` cru
 * do back (é inglês e técnico). A ordem de busca, da mais específica para a mais geral:
 *   1. `RANGE_OVERLAP` + `details.constraint`  -> `admin.insuranceErrors.rangeOverlap.<constraint>`
 *   2. `INVALID_<constraint>`                  -> `admin.insuranceErrors.constraints.<constraint>`
 *   3. `<code>`                                -> `admin.insuranceErrors.codes.<code>`
 *   4. status (403/404/409/422/400)            -> `admin.insuranceErrors.byStatus.<status>`
 *   5.                                          `admin.insuranceErrors.generic`
 */
import type { TFunction } from 'i18next';

const NS = 'admin.insuranceErrors';

interface ErrorLike {
  code?: unknown;
  status?: unknown;
  details?: unknown;
}

const asLike = (err: unknown): ErrorLike => (typeof err === 'object' && err !== null ? (err as ErrorLike) : {});

/** O `code` do erro, quando existe (string). */
export function insuranceErrorCode(err: unknown): string | null {
  const { code } = asLike(err);
  return typeof code === 'string' && code !== '' ? code : null;
}

/** Códigos em que a tela oferece uma saída (botão) em vez de só uma frase. */
export const NEEDS_NEW_SERVICE = 'REQUIRES_NEW_SERVICE';
export const NEEDS_CORRECTION = 'USE_CORRECTION';

/** Lista as chaves candidatas, da mais específica para a mais geral. Exportada para o teste travar a ordem. */
export function insuranceErrorKeys(err: unknown): string[] {
  const { status, details } = asLike(err);
  const code = insuranceErrorCode(err);
  const keys: string[] = [];
  if (code === 'RANGE_OVERLAP') {
    const constraint = typeof details === 'object' && details !== null ? (details as { constraint?: unknown }).constraint : undefined;
    if (typeof constraint === 'string') keys.push(`${NS}.rangeOverlap.${constraint}`);
  }
  if (code?.startsWith('INVALID_')) keys.push(`${NS}.constraints.${code.slice('INVALID_'.length)}`);
  if (code) keys.push(`${NS}.codes.${code}`);
  if (typeof status === 'number') keys.push(`${NS}.byStatus.${status}`);
  keys.push(`${NS}.generic`);
  return keys;
}

/** O texto da tela para um erro de obra social/contrato/vínculo. Sempre devolve uma frase traduzida. */
export function insuranceErrorText(t: TFunction, err: unknown): string {
  for (const key of insuranceErrorKeys(err)) {
    const text = t(key, { defaultValue: '' });
    if (typeof text === 'string' && text !== '') return text;
  }
  return t(`${NS}.generic`);
}
