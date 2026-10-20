/**
 * insuranceErrorResponse — o MAPA DE ERROS único da spec 058 (§K, plan §1.6): todo controller de obra social/contrato/vínculo devolve o
 * erro conhecido por aqui; o que NÃO é conhecido volta `false` e o chamador faz `reportError` + 500 (legado/inesperado = alarme).
 *
 *   P0001 (message = código da função de banco)  → 422 com o próprio código
 *   23514 (CHECK / trigger de imutabilidade)     → 422 `INVALID_<constraint>`
 *   23P01 (EXCLUDE: sobreposição)                → 409 `RANGE_OVERLAP`
 *   40001/40P01 esgotados (ConcurrencyConflict)  → 409
 *   23505                                        → já despachado POR NOME de constraint no repositório (classes com `httpStatus`)
 *   22000                                        → 422
 *
 * Nada do corpo da request entra na resposta: só o código, o nome da constraint e ids/nomes de campo.
 */
import type { Response } from 'express';
import { ConcurrencyConflictError } from '@shared/database/withSerializationRetry';

/** Códigos que as funções de banco da 058 levantam em `P0001` (a MESSAGE da exceção é o código). */
export const P0001_CODES = [
  'REQUIRES_NEW_SERVICE',
  'USE_CORRECTION',
  'TWO_PAYERS_OVERLAP',
  'COUNTRY_MISMATCH',
  'PAYER_KIND_REQUIRED',
  'PAYER_KIND_CANNOT_UNSET',
  'SERVICE_HAS_CONTRACT_LINK',
  'UNKNOWN_COUNTRY',
  'ITINERARY_SLOT_CAPACITY_EXCEEDED',
  'PROVIDERS_NEEDED_BELOW_OCCUPANCY',
  'PROVIDERS_NEEDED_CANNOT_CLEAR',
] as const;
export type P0001Code = (typeof P0001_CODES)[number];

/** Erro de domínio que já sabe o próprio status HTTP e código. */
export interface HttpDomainError extends Error {
  readonly httpStatus: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
}

export function isHttpDomainError(e: unknown): e is HttpDomainError {
  return e instanceof Error && typeof (e as { httpStatus?: unknown }).httpStatus === 'number' && typeof (e as { code?: unknown }).code === 'string';
}

interface PgErrorLike {
  code?: string;
  message?: string;
  constraint?: string;
}

const pgOf = (e: unknown): PgErrorLike | null => (typeof e === 'object' && e !== null ? (e as PgErrorLike) : null);

/** Devolve `{status, body}` para um erro CONHECIDO, ou `null` para o inesperado. */
export function insuranceErrorBody(err: unknown): { status: number; body: Record<string, unknown> } | null {
  if (err instanceof ConcurrencyConflictError) {
    return { status: 409, body: { success: false, error: 'Concurrent update conflict', code: err.code } };
  }
  if (isHttpDomainError(err)) {
    return { status: err.httpStatus, body: { success: false, error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) } };
  }
  const pg = pgOf(err);
  if (!pg) return null;
  if (pg.code === 'P0001' && (P0001_CODES as readonly string[]).includes(pg.message ?? '')) {
    return { status: 422, body: { success: false, error: pg.message, code: pg.message } };
  }
  if (pg.code === '23514') {
    const which = pg.constraint ?? pg.message ?? 'check';
    return { status: 422, body: { success: false, error: 'Constraint violated', code: `INVALID_${which}` } };
  }
  if (pg.code === '23P01') {
    return { status: 409, body: { success: false, error: 'Range overlap', code: 'RANGE_OVERLAP', ...(pg.constraint ? { details: { constraint: pg.constraint } } : {}) } };
  }
  if (pg.code === '22000') {
    return { status: 422, body: { success: false, error: 'Unprocessable', code: 'UNPROCESSABLE' } };
  }
  return null;
}

/** `true` se respondeu; `false` se o erro é inesperado (o chamador loga e devolve 500). */
export function respondInsuranceError(err: unknown, res: Response): boolean {
  const mapped = insuranceErrorBody(err);
  if (!mapped) return false;
  res.status(mapped.status).json(mapped.body);
  return true;
}
