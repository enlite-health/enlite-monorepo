/**
 * itineraryAllocationGate — DX-11.6: quem pode ser alocado num slot do itinerário (quadro C).
 * Função pura, sem banco: só lê o `team` que `deriveServiceTeam`/`deriveServiceTeamFromRows` já
 * calculou — nenhuma 2ª definição de Selecionado, ela é a MESMA do quadro C (Fase 10).
 *
 * `team.selected` → sim, sempre (o caminho comum: candidato da vaga viva em Equipe de Resposta
 * Rápida, nem alocado nem rejeitado). `team.inService` só abre a 2ª porta quando o prestador AINDA
 * é candidato em Equipe de Resposta Rápida da vaga viva (`candidacyWorkerIds`, a lista CRUA de
 * candidaturas — não a `team.selected` derivada, que já exclui quem está alocado) — é o caso do 2º
 * slot do MESMO serviço (ressalva (b'), Q-11.3): um AT de segunda a sexta 08-12 sai de `selected`
 * assim que a 1ª alocação vira `inService`; sem essa segunda porta, os slots 2 a 5 do mesmo AT
 * nunca poderiam ser criados. Quem saiu de Equipe de Resposta Rápida (a candidatura avançou/saiu do
 * funil) não abre essa porta, mesmo já alocado noutro slot.
 */
import type { DeriveServiceTeamResult } from './deriveServiceTeam';

export function canAllocate(
  team: DeriveServiceTeamResult,
  candidacyWorkerIds: ReadonlySet<string>,
  workerId: string,
): boolean {
  if (team.selected.some((entry) => entry.workerId === workerId)) return true;
  return team.inService.some((entry) => entry.workerId === workerId) && candidacyWorkerIds.has(workerId);
}
