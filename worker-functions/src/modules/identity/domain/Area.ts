/**
 * Áreas e papéis que o registro de vínculos GUARDA (`iam.area_membership`, migration 581).
 *
 * Os pares válidos são exatamente o CHECK `area_membership_area_role` do banco (paridade provada em
 * `tests/e2e/area-membership-schema.e2e.test.ts`). Ficam de fora, de propósito:
 *   - `clinic`: sem papel permitido (DF-10);
 *   - `backoffice`·staff e `care`·worker: têm dono em outro lugar (login do token e `workers.auth_uid`) e são
 *     DERIVADOS, nunca gravados (D514, DF-11).
 */
export const STORED_AREA_ROLES = {
  care: ['family'],
  learn: ['learner', 'teacher', 'manager'],
} as const;

export type StoredArea = keyof typeof STORED_AREA_ROLES;
export type StoredAreaRole = (typeof STORED_AREA_ROLES)[StoredArea][number];

/** Todos os pares (area, role) aceitos pelo banco. */
export const STORED_AREA_ROLE_PAIRS: ReadonlyArray<readonly [StoredArea, StoredAreaRole]> = (
  Object.keys(STORED_AREA_ROLES) as StoredArea[]
).flatMap((area) => STORED_AREA_ROLES[area].map((role) => [area, role] as const));

export function isStoredAreaRole(area: string, role: string): boolean {
  return STORED_AREA_ROLE_PAIRS.some(([a, r]) => a === area && r === role);
}
