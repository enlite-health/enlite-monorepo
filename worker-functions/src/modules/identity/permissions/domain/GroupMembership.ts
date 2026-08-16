/**
 * src/modules/identity/permissions/domain/GroupMembership.ts
 *
 * Vínculo staff↔grupo, com HISTÓRICO: sair de um grupo é `removed_at`/
 * `removed_by` (mig 275), nunca DELETE — "o vínculo deixa de valer imediatamente
 * e o histórico permanece consultável" (spec permission-groups).
 *
 * Uma linha VIVA por par (user, grupo) é garantida pelo índice único parcial
 * `uq_user_groups_live`; as removidas se acumulam ao lado.
 */

export interface GroupMembership {
  id: string;
  userId: string;
  groupId: string;
  tenantId: string;
  assignedBy: string | null;
  assignedAt: Date;
  removedBy: string | null;
  removedAt: Date | null;
}

/** Vínculo vigente = o que `iam.effective_permissions` enxerga. */
export function isLiveMembership(m: Pick<GroupMembership, 'removedAt'>): boolean {
  return m.removedAt === null;
}

/** Concessão de país a um grupo (`iam.group_country_scopes`, mig 268). */
export interface CountryGrant {
  id: string;
  groupId: string;
  country: string;
  grantedBy: string | null;
  grantedAt: Date;
  /** Obrigatório na concessão (mig 279) — é a justificativa auditável. */
  reason: string | null;
  revokedAt: Date | null;
}

export function isLiveGrant(g: Pick<CountryGrant, 'revokedAt'>): boolean {
  return g.revokedAt === null;
}
