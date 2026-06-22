/**
 * suggestSurvivorId
 *
 * Escolhe a conta sugerida como sobrevivente dentro de um grupo de duplicados,
 * a partir das contas já materializadas (DedupWorkerAccountDetail).
 *
 * Regra (determinística, sempre retorna um id — nunca undefined):
 *   1. Se houver exatamente UMA conta tier 1 (humano real), ela vence.
 *   2. Caso contrário, escolhe a "mais completa": maior soma de
 *      (wja + docs + encuadres), com login_real como desempate, e
 *      created_at mais antigo como último critério.
 *
 * Manter no application layer: espelha a heurística de ListDedupGroupsUseCase
 * sem depender do shape cru de linha do banco.
 */

import type { DedupWorkerAccountDetail } from './DedupTypes';

function activitySum(a: DedupWorkerAccountDetail): number {
  return a.wja_count + a.docs_count + a.encuadres_count;
}

export function suggestSurvivorId(accounts: DedupWorkerAccountDetail[]): string {
  // Pré-condição do chamador: accounts.length >= 1.
  const tier1 = accounts.filter(a => a.tier === 1);
  if (tier1.length === 1) return tier1[0].id;

  const sorted = [...accounts].sort((a, b) => {
    const actDiff = activitySum(b) - activitySum(a);
    if (actDiff !== 0) return actDiff;

    const loginDiff = Number(b.login_real) - Number(a.login_real);
    if (loginDiff !== 0) return loginDiff;

    // Mais antigo primeiro (created_at ISO — ordem lexicográfica = cronológica).
    return a.created_at.localeCompare(b.created_at);
  });

  return sorted[0].id;
}
