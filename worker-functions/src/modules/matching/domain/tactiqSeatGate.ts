/**
 * Regra única da trava de licença antes do 1º vínculo (change tactiq-vinculo-resiliente, F5, design D16). Sem import de infraestrutura.
 * Dono do conceito "a pessoa pode começar o vínculo": a API (`getOwn.canStartLink`) e o `startLink` leem DAQUI; a tela nunca recalcula.
 */

/** Eventos da trilha que carregam a declaração do Acesso Master; a declaração vigente é a do evento MAIS NOVO dos dois. */
export const SEAT_DECLARED_KIND = 'tactiq_link.seat_declared';
export const SEAT_UNDECLARED_KIND = 'tactiq_link.seat_undeclared';

export interface SeatGateInput {
  /** Existe linha em `tactiq_links` (qualquer status). Quem já tem linha é legado e nunca é travado (D16). */
  hasRow: boolean;
  /** O Acesso Master declarou "Licencia asignada" (evento mais novo = `seat_declared`). */
  seatDeclared: boolean;
}

/** Pode começar o vínculo: já tem linha (legado) OU a licença está declarada. */
export function canStartLink({ hasRow, seatDeclared }: SeatGateInput): boolean {
  return hasRow || seatDeclared;
}
