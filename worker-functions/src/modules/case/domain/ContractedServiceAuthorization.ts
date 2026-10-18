/**
 * ContractedServiceAuthorization — horas autorizadas pela obra social para UM serviço contratado (spec 056 §4.3).
 *
 * Na API a vigência é INCLUSIVA (`validTo` = último dia autorizado); no banco é `daterange [)`
 * (`upper` = dia seguinte). Estas duas funções são o ÚNICO ponto de conversão (D517).
 */
export interface AuthorizationView {
  id: string;
  hours: number;
  validFrom: string;
  validTo: string;
  recordedAt: string;
  recordedBy: string;
  supersededAt: string | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function shiftDay(isoDate: string, days: number): string {
  if (!ISO_DATE.test(isoDate)) throw new Error('invalid ISO date');
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** `validTo` inclusivo (API) → `upper` exclusivo (banco). */
export function exclusiveUpperOf(validTo: string): string {
  return shiftDay(validTo, 1);
}

/** `upper(valid)` exclusivo (banco) → `validTo` inclusivo (API). */
export function inclusiveValidToOf(upper: string): string {
  return shiftDay(upper, -1);
}

export class AuthorizationOverlapsError extends Error {
  readonly code = 'AUTHORIZATION_OVERLAPS';
  constructor() {
    super('another current authorization overlaps this period');
    this.name = 'AuthorizationOverlapsError';
  }
}

export class AuthorizationNotFoundError extends Error {
  readonly code = 'AUTHORIZATION_NOT_FOUND';
  constructor() {
    super('authorization not found or already superseded');
    this.name = 'AuthorizationNotFoundError';
  }
}
