import type { AdmissionCountry } from './admissionCountries';

/**
 * Configuração do evento de enquadre no Google (spec 052, Fase 2). Funções PURAS, sem I/O: o ambiente entra por argumento.
 *
 *  - agenda dedicada do enquadre por país: `ENQUADRE_CALENDAR_ID_<PAÍS>` (mesmo padrão de `ADMISSION_CALENDAR_ID_<PAÍS>`);
 *  - trava de canal real: `ENQUADRE_GUEST_POLICY` = `all` | `allowlist:dominio1,dominio2`. FAIL-CLOSED: ausente ou malformada
 *    recusa a criação. Stage e produção rodam com a mesma conta impersonada; sem a trava, um teste na stage convidaria qualquer
 *    e-mail que estivesse no banco de lá. Produção = `all`; stage = `allowlist:` com os domínios de teste.
 * Nenhuma mensagem de erro carrega e-mail de convidado (só quantidade).
 */

export type EnquadreEnv = Readonly<Record<string, string | undefined>>;

export class EnquadreConfigError extends Error {
  readonly code = 'ENQUADRE_CONFIG_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'EnquadreConfigError';
  }
}

export class EnquadreGuestNotAllowedError extends Error {
  readonly code = 'ENQUADRE_GUEST_NOT_ALLOWED';
  constructor(readonly refusedCount: number) {
    super(`[enquadre] ${refusedCount} convidado(s) fora da política ENQUADRE_GUEST_POLICY`);
    this.name = 'EnquadreGuestNotAllowedError';
  }
}

export type GuestPolicy = { kind: 'all' } | { kind: 'allowlist'; domains: readonly string[] };

export const ENQUADRE_GUEST_POLICY_ENV = 'ENQUADRE_GUEST_POLICY';

export function enquadreCalendarIdEnvName(country: AdmissionCountry): string {
  return `ENQUADRE_CALENDAR_ID_${country}`;
}

export function resolveEnquadreCalendarId(country: AdmissionCountry, env: EnquadreEnv): string {
  const name = enquadreCalendarIdEnvName(country);
  const value = env[name]?.trim();
  if (!value) throw new EnquadreConfigError(`[enquadre] missing env ${name} for country ${country}`);
  return value;
}

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export function parseGuestPolicy(env: EnquadreEnv): GuestPolicy {
  const raw = env[ENQUADRE_GUEST_POLICY_ENV]?.trim();
  if (!raw) throw new EnquadreConfigError(`[enquadre] missing env ${ENQUADRE_GUEST_POLICY_ENV} (all | allowlist:dominio1,dominio2)`);
  if (raw === 'all') return { kind: 'all' };
  if (raw.startsWith('allowlist:')) {
    const domains = raw
      .slice('allowlist:'.length)
      .split(',')
      .map((d) => d.trim().toLowerCase());
    if (domains.length > 0 && domains.every((d) => DOMAIN_RE.test(d))) return { kind: 'allowlist', domains };
  }
  throw new EnquadreConfigError(`[enquadre] malformed ${ENQUADRE_GUEST_POLICY_ENV} (all | allowlist:dominio1,dominio2)`);
}

function domainOf(email: string): string {
  const at = email.lastIndexOf('@');
  return at < 0 ? '' : email.slice(at + 1).trim().toLowerCase();
}

/** Lança `EnquadreGuestNotAllowedError` (`code = 'ENQUADRE_GUEST_NOT_ALLOWED'`) se algum e-mail estiver fora da política. */
export function assertGuestsAllowed(policy: GuestPolicy, emails: readonly string[]): void {
  if (policy.kind === 'all') return;
  const refused = emails.filter((e) => !policy.domains.includes(domainOf(e))).length;
  if (refused > 0) throw new EnquadreGuestNotAllowedError(refused);
}
