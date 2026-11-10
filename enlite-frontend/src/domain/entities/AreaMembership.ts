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

/**
 * Conceder aceita `personId` OU `uid` (quem só tem login e nunca virou pessoa): o servidor
 * resolve o uid e concede na mesma transação.
 */
export type GrantAreaMembershipInput =
  | { personId: string; area: string; role: string }
  | { uid: string; area: string; role: string };

/** Tipo da pessoa na lista — prioridade staff > worker > account (decidido no servidor). */
export type AreaPersonKind = 'staff' | 'worker' | 'account';

export const AREA_PERSON_KINDS: readonly AreaPersonKind[] = ['staff', 'worker', 'account'];

/** Vínculo vivo como a lista o resume (sem quem concedeu / quando). */
export interface AreaPersonMembership {
  id: string;
  area: string;
  role: string;
}

/** Uma linha da aba "Vínculos de área": uma pessoa raiz com os vínculos vivos da árvore. */
export interface AreaPerson {
  /** `null` = conta de login que nunca virou pessoa; a concessão vai por `uid`. */
  personId: string | null;
  uid: string | null;
  displayName: string;
  email: string | null;
  kind: AreaPersonKind;
  memberships: AreaPersonMembership[];
}

export interface AreaPeoplePage {
  items: AreaPerson[];
  total: number;
  limit: number;
  offset: number;
}

export type AreaPeopleTypeFilter = 'all' | AreaPersonKind;

export interface AreaPeopleQuery {
  search?: string;
  type?: AreaPeopleTypeFilter;
  withMembership?: boolean;
  limit?: number;
  offset?: number;
}

/** O servidor recusa busca por nome com menos de 3 caracteres (400) — a UI nem chama. */
export const AREA_PEOPLE_MIN_SEARCH = 3;

/** Chave estável da pessoa (a mesma serve à linha, ao painel e ao recarregamento). */
export function areaPersonKey(p: Pick<AreaPerson, 'personId' | 'uid' | 'email'>): string {
  return p.personId ?? p.uid ?? p.email ?? '';
}

/** Como conceder a esta pessoa: por `personId` quando existe, senão por `uid`. */
export function grantTarget(p: Pick<AreaPerson, 'personId' | 'uid'>): { personId: string } | { uid: string } | null {
  if (p.personId) return { personId: p.personId };
  if (p.uid) return { uid: p.uid };
  return null;
}
