/**
 * Tipo de conta — a resposta a "o que esta conta É", separada de "o que ela PODE".
 *
 * Até 07/09 as duas perguntas moravam em `users.role`: o papel era nível de acesso
 * (`admin` × `recruiter`) E fronteira staff × prestador. A D293 tirou o nível (a
 * célula decide); a D294 tira a fronteira: ela passa a ser `users.account_type`,
 * espelhada no custom claim `account_type` do Identity Platform.
 *
 * Medido em 07/09: `users` só tem staff em prod (18) e stage (30) — o prestador
 * vive em `workers.auth_uid` e nunca ganha linha aqui. `worker` existe no
 * vocabulário porque a migration 003 o previa (e o trigger `onUserCreate`, que
 * não roda no Cloud Run, o gravaria); os próximos tipos (obra social, paciente)
 * entram AQUI, na migration que os criar e na tela que os usar — nunca por
 * `role`.
 *
 * `accountTypeForRole` é a PONTE: converte o papel legado (claim `role` ou a
 * coluna) no tipo, para conta cujo claim `account_type` ainda não foi gravado.
 * Quando o backfill do claim terminar e `role` for apagada (D293 passos 2-3),
 * esta função vai junto. Espelho SQL: `account_type_for_role` (migration 414).
 */
import { isStaffRole } from './EnliteRole';

export const ACCOUNT_TYPES = ['staff', 'worker'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const STAFF_ACCOUNT: AccountType = 'staff';

export function isAccountType(value: unknown): value is AccountType {
  return typeof value === 'string' && (ACCOUNT_TYPES as readonly string[]).includes(value);
}

/** Ponte legado → tipo. `null` = papel que não classifica (fail-closed: não vira staff). */
export function accountTypeForRole(role: string | null | undefined): AccountType | null {
  if (!role) return null;
  if (isStaffRole(role)) return 'staff';
  if (role === 'worker') return 'worker';
  return null;
}

/** O que a autenticação pendura no principal; `accountType` vence, `roles` é a ponte. */
export interface AccountTyped {
  accountType?: string | null;
  roles?: readonly string[] | null;
}

/**
 * A fronteira staff × prestador, em UM lugar. Positiva de propósito: só é staff quem
 * tem o tipo `staff` declarado, ou — na ponte — um papel de staff reconhecido.
 */
export function isStaffAccount(principal: AccountTyped): boolean {
  if (principal.accountType !== undefined && principal.accountType !== null) {
    return principal.accountType === STAFF_ACCOUNT;
  }
  return (principal.roles ?? []).some((role) => accountTypeForRole(role) === STAFF_ACCOUNT);
}

/** O tipo resolvido do principal — declarado, ou derivado do papel (ponte). */
export function resolveAccountType(principal: AccountTyped): AccountType | null {
  if (isAccountType(principal.accountType)) return principal.accountType;
  for (const role of principal.roles ?? []) {
    const derived = accountTypeForRole(role);
    if (derived) return derived;
  }
  return null;
}
