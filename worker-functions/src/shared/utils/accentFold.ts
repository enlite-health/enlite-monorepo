/**
 * accentFold — dobrar acento dos DOIS lados da comparação, com a mesma tabela.
 *
 * O problema: quem procura "Peña" digita "Pena", e quem procura "García" digita
 * "Garcia". `ILIKE` não ignora diacrítico, então a busca por nome do mapa
 * respondia "Sin resultados" para meio mercado argentino. O filtro em memória
 * que ela substituiu NÃO tinha esse defeito (usava NFD no cliente), então isto
 * era regressão, não limitação herdada.
 *
 * ⚠️ POR QUE NÃO `unaccent`. A extensão EXISTE em produção (medido em
 * 07/09/2026, versão 1.1), mas NENHUMA migration a cria — ela chegou lá por
 * fora. Migration em produção neste repo é passo MANUAL, e eu não tinha como
 * medir a `stage`: se ela não tivesse a extensão, a busca viraria 500 no dia do
 * deploy. `translate()` é SQL puro, roda em qualquer Postgres e não carrega
 * dependência de ambiente. Trocar por `unaccent` (com migration e índice
 * funcional) é melhoria legítima quando alguém puder medir os três ambientes.
 *
 * ⚠️ A SIMETRIA É O PONTO. Se o termo digitado fosse dobrado por uma tabela e a
 * coluna por outra, a busca falharia só nos casos acentuados — o modo de falha
 * mais difícil de notar, porque o caso comum continua funcionando. Por isso as
 * duas pontas saem da MESMA constante, e há teste afirmando que `foldAccents` e
 * o `translate()` gerado tratam cada caractere igual.
 */

/**
 * Os pares, na ordem. `FROM[i]` vira `TO[i]`.
 *
 * Cobre espanhol e português — os dois idiomas em que os nomes desta base são
 * escritos. `ñ`→`n` e `ç`→`c` entram de propósito: quem digita "Muñoz" como
 * "Munoz" e "Gonçalves" como "Goncalves" é a regra, não a exceção.
 */
export const ACCENT_FROM = 'áàâãäéèêëíìîïóòôõöúùûüñçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÑÇ';
export const ACCENT_TO = 'aaaaaeeeeiiiiooooouuuuncAAAAAEEEEIIIIOOOOOUUUUNC';

/** Dobra o acento de um termo digitado. Espelho exato de `sqlFoldAccents`. */
export function foldAccents(value: string): string {
  let out = '';
  for (const ch of value) {
    const i = ACCENT_FROM.indexOf(ch);
    out += i === -1 ? ch : ACCENT_TO[i];
  }
  return out;
}

/**
 * O mesmo, do lado do banco: embrulha uma expressão SQL num `translate()`.
 *
 * `translate()` é função de string do core do Postgres — sem extensão, sem
 * migration, disponível em qualquer instalação. Não é indexável sem índice
 * funcional, o que aqui não pesa: a tabela `patients` tem centenas de linhas,
 * não milhões, e a consulta já era um scan por `ILIKE '%termo%'`.
 */
export function sqlFoldAccents(expr: string): string {
  return `translate(${expr}, '${ACCENT_FROM}', '${ACCENT_TO}')`;
}
