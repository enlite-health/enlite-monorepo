/**
 * testRealmSql
 *
 * Dono único do recorte de dado de teste (D664): worker e vaga marcados
 * `is_test` ficam fora da operação e das métricas.
 *
 * Qual helper usar:
 *   - por VAGA ou por par worker×vaga (kanban, convocáveis, ficha da vaga):
 *     `sameRealmAsVacancySql` — o worker de teste continua visível na vaga de
 *     teste (o monitor de prd lê a tarjeta dele lá), e some na vaga real.
 *   - lista, contagem ou métrica: `excludeTestWorkerSql` / `workerNotTestSql` e
 *     `excludeTestVacancySql` / `vacancyNotTestSql`.
 *   - lista do catálogo de pagadores (obras sociais/prepagas): `excludeTestPayerSql`.
 *     Contrato e vínculo serviço->contrato derivam do pagador (sem coluna própria);
 *     detalhe por código, nome repetido e próxima posição leem a tabela inteira.
 *
 * Não confundir com `activeWorkerFilter` (recorte de worker desativado): são
 * conceitos distintos e aquele também serve de identidade, por isso não se estende.
 */

/** Worker de teste fora da lista/contagem; `alias` é o alias da tabela `workers`. */
export function excludeTestWorkerSql(alias = 'w'): string {
  return `COALESCE(${alias}.is_test, false) = false`;
}

/** Worker de teste fora, a partir de uma expressão de id (sem JOIN com `workers`). */
export function workerNotTestSql(workerIdExpr: string): string {
  return `NOT EXISTS (SELECT 1 FROM workers w_test_chk WHERE w_test_chk.id = ${workerIdExpr} AND w_test_chk.is_test = true)`;
}

/** Vaga de teste fora da lista/contagem; `alias` é o alias da tabela `job_postings`. */
export function excludeTestVacancySql(alias = 'jp'): string {
  return `COALESCE(${alias}.is_test, false) = false`;
}

/** Vaga de teste fora, a partir de uma expressão de id (sem JOIN com `job_postings`). */
export function vacancyNotTestSql(vacancyIdExpr: string): string {
  return `NOT EXISTS (SELECT 1 FROM job_postings jp_test_chk WHERE jp_test_chk.id = ${vacancyIdExpr} AND jp_test_chk.is_test = true)`;
}

/** Pagador de teste fora da lista do catálogo; `alias` é o alias (ou o nome) da tabela `insurance_providers`. */
export function excludeTestPayerSql(alias = 'p'): string {
  return `COALESCE(${alias}.is_test, false) = false`;
}

/** Worker e vaga no mesmo realm (ambos de teste ou ambos reais); null-safe. */
export function sameRealmAsVacancySql(workerIdExpr: string, vacancyIdExpr: string): string {
  return `COALESCE((SELECT w_realm_chk.is_test FROM workers w_realm_chk WHERE w_realm_chk.id = ${workerIdExpr}), false) = COALESCE((SELECT jp_realm_chk.is_test FROM job_postings jp_realm_chk WHERE jp_realm_chk.id = ${vacancyIdExpr}), false)`;
}
