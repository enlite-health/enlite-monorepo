/**
 * itineraryAllocationGate — quem pode ser alocado num slot do itinerário. Função pura, sem banco.
 *
 * 041 R1 (DEC-04/DEC-05): o gate é o MESMO pool das opções (`deriveAllocationPool`) — quem está em
 * "Selecionados" ou "Equipe de Resposta Rápida" da vaga viva, sem marca de rejeição. Quem já está
 * alocado e segue numa das duas colunas continua alocável (2º slot do mesmo serviço, Q-11.3); quem
 * saiu das duas colunas não é alocável, mesmo já alocado noutro slot. Antes era `team.selected`
 * (só `QUICK_RESPONSE_TEAM`) + 2ª porta por `candidacyWorkerIds`.
 */
import type { AllocationPoolEntry } from './deriveServiceTeam';

export function canAllocate(pool: readonly AllocationPoolEntry[], workerId: string): boolean {
  return pool.some((entry) => entry.workerId === workerId);
}
