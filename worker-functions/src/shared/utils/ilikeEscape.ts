/**
 * ilikeEscape — neutraliza os curingas do `LIKE`/`ILIKE` num termo digitado.
 *
 * `%` casa qualquer coisa e `_` casa um caractere. Num `ILIKE '%' || $1 || '%'`
 * alimentado por caixa de busca, isso quer dizer que **o usuário escolhe quanto
 * a consulta devolve**: o termo `%%` casa a tabela inteira, e `__` também.
 *
 * Onde a busca é o ESCOPO da consulta — como no mapa de pacientes, em que
 * `search` sozinho satisfaz a exigência de recorte —, o curinga transforma uma
 * busca por nome em export da base: 500 domicílios com nome, bairro e
 * coordenada, e o log registrando um inocente "houve busca". Foi o achado que
 * bloqueou o PR #320 em 07/09/2026.
 *
 * Escapa também a própria `\`, senão um termo terminado em barra deixaria a
 * cláusula `ESCAPE` pendurada e o Postgres devolveria erro de sintaxe.
 *
 * ⚠️ Escapar o VALOR não basta sozinho: quem monta o SQL tem de fechar a
 * cláusula com `ESCAPE '\\'` (que no SQL vira `ESCAPE '\'`) — sem ela a barra
 * que esta função insere é lida como caractere comum e o curinga volta a valer.
 * Ver `buildPatientsMapQuery` e `IcdCatalogTerminology.buscar`.
 *
 * Isto NÃO é proteção contra injeção — o termo continua indo como parâmetro
 * (`$n`), nunca concatenado. É proteção contra ALCANCE.
 */
export function escapeIlikeWildcards(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * O termo tem conteúdo que não seja curinga ou pontuação de busca?
 *
 * Segunda camada, por profundidade: mesmo escapado, `%%` é um termo que não
 * quer dizer nada — devolve zero linhas, mas ainda faz o banco varrer a tabela
 * para descobrir isso. Rejeitar na borda é mais barato e diz a verdade ao
 * cliente ("isso não é uma busca") em vez de devolver lista vazia.
 */
export function hasSearchableContent(value: string): boolean {
  return value.replace(/[\\%_\s]/g, '').length > 0;
}
