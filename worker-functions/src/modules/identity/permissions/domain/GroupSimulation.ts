/**
 * src/modules/identity/permissions/domain/GroupSimulation.ts
 *
 * Spec 026 (D407): o período em que um membro VIVO do Acesso Master simula
 * OUTRO grupo — `iam.effective_permissions`/`iam.effective_countries`
 * (migration 458) passam a decidir pelo grupo simulado, nunca pela filiação
 * real, enquanto durar. Troca = fecha a aberta + abre outra; nunca soma
 * (`iam.acting_groups`, mig 458).
 *
 * O shape aqui é o MESMO que `ResolvedAuthz.simulation` expõe ao painel
 * (contrato `me-simulation.md`, `data-model.md` §Trilha) — sem `endedAt`: só
 * simulação VIVA chega até este tipo, porque a SQL `iam.active_group_simulation`
 * já filtra `ended_at IS NULL AND expires_at > now()` antes de qualquer linha
 * voltar (o banco é a autoridade da invariante, como em todo o módulo).
 *
 * `isLiveSimulation` existe para quem olha a linha CRUA da tabela (antes desse
 * filtro do banco) decidir sem duplicar a regra em dois lugares — molde
 * `isLiveMembership`/`isLiveGrant` (GroupMembership.ts): função pura, sem
 * classe, operando em `Pick` do que precisa.
 */

export interface GroupSimulation {
  id: string;
  /** Grupo que DECIDE durante a simulação — nunca o Acesso Master (guard na writer function). */
  groupId: string;
  groupName: string;
  startedAt: Date;
  expiresAt: Date;
}

/**
 * Vivo = aberta (`endedAt === null`) e ainda dentro do prazo (`expiresAt > now`).
 * As duas condições, porque uma simulação pode estar ENCERRADA mas ainda "no
 * prazo" (encerramento manual antes do vencimento) — só `endedAt` decide isso;
 * `expiresAt` sozinho não distingue "fechada cedo" de "ainda rolando".
 */
export function isLiveSimulation(
  s: Pick<GroupSimulation, 'expiresAt'> & { endedAt: Date | null },
  now: Date,
): boolean {
  return s.endedAt === null && s.expiresAt > now;
}
