/**
 * Cálculo puro (sem I/O) usado por AnaCareMirrorHealthService.
 * Extraído para ser testável isoladamente (unit determinístico, sem banco) —
 * mesmo padrão de domainEventBacklogMath.ts.
 */

/**
 * Idade em horas do worker preso mais antigo.
 * Retorna 0 quando não há nenhum preso (oldestStuckCreatedAt null).
 */
export function computeOldestStuckAgeHours(
  oldestStuckCreatedAt: Date | null,
  now: Date = new Date(),
): number {
  if (!oldestStuckCreatedAt) return 0;
  const diffMs = now.getTime() - oldestStuckCreatedAt.getTime();
  return Math.max(0, Math.round((diffMs / 3_600_000) * 10) / 10);
}

/**
 * O espelho está quebrado quando EXISTE pelo menos um worker elegível dentro
 * da janela de recência que já passou do limite sem ganhar `ana_care_id`.
 *
 * É uma pergunta de ESTADO ("existe alguém preso agora?"), não de borda
 * ("falhou agora?"). Enquanto a resposta for sim, o health check reemite o
 * WARN a cada ciclo do cron — a métrica nunca zera sozinha.
 */
export function isMirrorStuck(stuckRecent: number): boolean {
  return stuckRecent > 0;
}
