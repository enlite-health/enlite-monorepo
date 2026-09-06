/**
 * fullName — quebra o nome completo colhido em UM campo do formulário público.
 *
 * A tela pede "nome completo" numa caixa só (decisão do Gabriel, 02/09) porque
 * dois campos dobram a fricção de um formulário que tem quatro. A quebra é
 * deliberadamente ingênua — **primeiro token é o nome, o resto é o sobrenome** —
 * e é assim que tem de ser: qualquer heurística mais esperta erra em nome
 * hispânico com dois sobrenomes ("García Márquez"), em partícula ("de los
 * Ángeles") e em nome composto ("Ana María"), e erra em silêncio. Ingênua, ela
 * erra de um jeito previsível e corrigível na ficha.
 *
 * O que ela NÃO faz: inventar sobrenome. Nome de um termo só devolve sobrenome
 * vazio, e quem grava decide o que fazer com isso (`patients.last_name` aceita
 * NULL; `patient_responsibles.last_name` é NOT NULL e recebe '').
 *
 * NORMALIZAÇÃO (Gabriel, 02/09): o valor é gravado em **minúsculas**, para que
 * "FLAVIA VILLAGRA", "Flavia Villagra" e "flavia villagra" virem a mesma linha.
 * A decisão é de armazenamento — a tela exibe o que está gravado, então o nome
 * aparece em minúsculas até que se decida capitalizar na exibição.
 */
export interface SplitName {
  firstName: string;
  /** '' quando o nome tem um único termo — nunca `null`, para o chamador decidir. */
  lastName: string;
}

/**
 * Quebra no primeiro espaço. Colapsa espaços repetidos e apara as pontas, para
 * que "  Flavia   Villagra  " não vire sobrenome com espaço no meio.
 *
 * Devolve `firstName: ''` só se a entrada for vazia/só espaço — caso que o
 * schema público já barra antes (`name` é obrigatório desde 02/09), mas que a
 * função trata em vez de assumir.
 */
export function splitFullName(fullName: string | null | undefined): SplitName {
  // `toLocaleLowerCase` e não `toLowerCase`: nomes daqui têm acento e ç, e o
  // caso turco do I é o exemplo clássico de por que a versão sem locale erra.
  const partes = (fullName ?? '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return { firstName: '', lastName: '' };
  const [primeiro, ...resto] = partes;
  return { firstName: primeiro, lastName: resto.join(' ') };
}

/** Quantos termos o nome tem. O schema público exige ao menos 2 (D249). */
export function countNameParts(fullName: string | null | undefined): number {
  return (fullName ?? '').trim().split(/\s+/).filter(Boolean).length;
}
