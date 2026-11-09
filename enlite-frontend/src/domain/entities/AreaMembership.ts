/**
 * Vínculos de área (acesso-do-cliente, F1/T111) — contrato de `/api/admin/area-memberships`.
 *
 * `STORED_AREA_ROLES` ESPELHA `worker-functions/src/modules/identity/domain/Area.ts` (os pares que o
 * CHECK `area_membership_area_role` do banco aceita). É a ÚNICA cópia no front: o formulário de
 * conceder deriva dela as áreas e os papéis. Ficam de fora, como no back, `clinic` (sem papel),
 * `backoffice`·staff e `care`·worker (derivados, nunca gravados).
 */
export const STORED_AREA_ROLES = {
  care: ['family'],
  learn: ['learner', 'teacher', 'manager'],
} as const;

export type StoredArea = keyof typeof STORED_AREA_ROLES;

export const STORED_AREAS = Object.keys(STORED_AREA_ROLES) as StoredArea[];

export interface AreaMembership {
  id: string;
  personId: string;
  area: string;
  role: string;
  grantedBy: string;
  grantedAt: string;
}

export interface AreaMembershipList {
  personId: string;
  memberships: AreaMembership[];
}

/** Como a busca identifica a pessoa — o contrato aceita um, e só um, dos dois. */
export type AreaMembershipLookup = { personId: string } | { uid: string };

export interface GrantAreaMembershipInput {
  personId: string;
  area: string;
  role: string;
}
