/**
 * ContractedServiceAuthorization — horas autorizadas pela obra social para UM serviço contratado (spec 056 §4.3).
 *
 * Na API a vigência é INCLUSIVA (`validTo` = último dia autorizado); no banco é meio-aberta. A conversão vive só em `dateRangeWire.ts` (D517).
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
