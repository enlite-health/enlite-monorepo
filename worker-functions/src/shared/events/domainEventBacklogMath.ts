/**
 * Cálculo puro (sem I/O) usado por DomainEventBacklogService.
 * Extraído para ser testável isoladamente (unit test determinístico,
 * sem depender de banco) — ver __tests__/domainEventBacklogMath.test.ts.
 */

/**
 * Idade em minutos do pending "recente" mais antigo de um grupo.
 * Retorna 0 quando não há nenhum pending recente (oldestRecentCreatedAt null).
 */
export function computeOldestRecentAgeMinutes(
  oldestRecentCreatedAt: Date | null,
  now: Date = new Date(),
): number {
  if (!oldestRecentCreatedAt) return 0;
  const diffMs = now.getTime() - oldestRecentCreatedAt.getTime();
  return Math.max(0, Math.floor(diffMs / 60_000));
}

/**
 * Um grupo de evento está "stuck" quando o pending recente mais antigo
 * já passou do threshold configurado (em minutos).
 */
export function isStuck(oldestRecentAgeMinutes: number, stuckThresholdMinutes: number): boolean {
  return oldestRecentAgeMinutes > stuckThresholdMinutes;
}
