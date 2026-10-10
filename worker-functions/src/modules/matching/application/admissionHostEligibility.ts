/**
 * Quem conta como responsável apta para o PAINEL (spec 050 F7).
 *
 * Uma só régua sobre o estado que o `TactiqLinkGate` devolve. Hoje "apta" é só o vínculo Tactiq `linked`.
 * O SITE não usa esta régua: sorteia entre as responsáveis ativas do roster (a trava do site volta com a tela de perfil, D495).
 */
import type { TactiqLinkState } from './ports/TactiqPorts';

export function isHostApt(state: TactiqLinkState | undefined): boolean {
  return state === 'linked';
}
