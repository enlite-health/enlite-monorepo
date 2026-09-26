/**
 * candidateDistance — o único comparador de distância do front (critério 3.11).
 *
 * Match (bucketize), Kanban (itemsOf) e o modo lista da tabela de funil ordenam
 * candidatos/cards/linhas por km crescente importando daqui. A expressão de fallback
 * para "sem distância" só existe UMA vez em `src` — no corpo desta função — porque o
 * critério 11 conta linhas.
 *
 * Ordem por km crescente; sem distância no fim. ÚNICO dono (critério 3.11): match e funil importam daqui.
 */
export interface HasDistanceKm {
  distanceKm?: number | null;
}

export function compareByDistanceKm(a: HasDistanceKm, b: HasDistanceKm): number {
  return (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity);
}
