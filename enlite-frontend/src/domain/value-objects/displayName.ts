/**
 * displayName — como um nome guardado em minúsculas volta para a tela.
 *
 * O lead público grava normalizado (`splitFullName`, D249): "FLAVIA VILLAGRA",
 * "Flavia Villagra" e "flavia villagra" viram a MESMA linha no banco. A
 * normalização é de armazenamento — ninguém quer ler "flavia villagra" no card,
 * então a capitalização acontece aqui, na borda de exibição.
 *
 * Partículas ficam minúsculas ("maría de los ángeles" → "María de los Ángeles"),
 * porque um Title Case ingênuo produz "De Los Ángeles", que está errado em
 * espanhol e em português. A primeira palavra é sempre capitalizada, mesmo que
 * seja partícula.
 *
 * Nomes que já vêm capitalizados do ClickUp passam intactos — "Juan" continua
 * "Juan". O que muda é "JUAN", que vira "Juan": melhor do que estava.
 */

/** Partículas de sobrenome que a convenção es/pt mantém em minúscula. */
const PARTICULAS = new Set([
  'de', 'del', 'de la', 'la', 'las', 'los', 'y', 'e',
  'da', 'das', 'do', 'dos', 'van', 'von',
]);

/**
 * Capitaliza para exibição. Devolve '' para entrada vazia — quem chama decide o
 * que mostrar no lugar (a lista usa o traço).
 */
export function toDisplayName(name: string | null | undefined): string {
  const partes = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return '';

  return partes
    .map((parte, i) => {
      const minuscula = parte.toLocaleLowerCase();
      // A primeira palavra nunca é rebaixada, nem quando é partícula.
      if (i > 0 && PARTICULAS.has(minuscula)) return minuscula;
      // `toLocaleUpperCase` na inicial: 'ángeles' → 'Ángeles' precisa do locale.
      return minuscula.charAt(0).toLocaleUpperCase() + minuscula.slice(1);
    })
    .join(' ');
}
