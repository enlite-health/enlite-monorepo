/**
 * Regras puras do re-teste do vínculo do Tactiq (change tactiq-vinculo-resiliente, D9: este arquivo é o dono do conceito).
 * Sem import de infraestrutura.
 */

/** "Causa assento": o Tactiq recusou por falta de licença (`access_action:request_seat`). Qualquer outra ação (ex.: `upgrade`) não é. */
export function isSeatCause(reason: string | null | undefined): boolean {
  return reason === 'access_action:request_seat';
}
