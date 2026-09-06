/**
 * conceptKey — a identidade de conceito ESTÁVEL ENTRE RELEASES, do lado TypeScript.
 *
 * 🔴 POR QUE ISTO EXISTE (T2 do QA-caça da F5, 05/09/2026). A URI canônica da OMS carrega o
 * release DENTRO do path:
 *
 *     http://id.who.int/icd/release/11/2026-01/mms/405565289/unspecified
 *                                      ^^^^^^^
 *
 * Ou seja: o MESMO conceito tem `icd_uri` DIFERENTE em cada release. Quem guardou uma URI
 * (o mapa `clickup_diagnosis_labels` da migration 327, a linha `patient_diagnoses.concept_uri`)
 * e depois pede ao catálogo para resolvê-la sob o release CORRENTE recebe `null` no dia da
 * primeira promoção — e, no caso do espelho do ClickUp, em silêncio: `RecordPatientDiagnosis`
 * devolve `concept_not_resolved`, o log é `info`, o webhook é 200 e não há linha de rejeição.
 *
 * A chave é tudo o que vem DEPOIS do segmento de release (`mms/405565289/unspecified`) — a
 * linearização mais o id da entidade, que a OMS mantém estável entre releases.
 *
 * 🔒 FONTE DA REGRA: a função SQL `terminology.concept_key(TEXT)` (migration 328), que também
 * alimenta a coluna GERADA `icd_entities.concept_key`. Esta função é o ESPELHO dela em TS, e
 * existe por um motivo só: o fake (`InMemoryTerminology`) não tem Postgres para chamar. O
 * adaptador real NÃO usa esta função — ele chama `terminology.concept_key($1)` no próprio SQL,
 * para que o caminho de produção tenha UMA regra, não duas.
 * O teste `tests/e2e/concept-key-parity.e2e.test.ts` prova que as duas concordam sobre URIs
 * REAIS do catálogo — se divergirem, ele fica vermelho.
 *
 * URI sem o marcador `/icd/release/11/<release>/` (fixture de teste, um vocabulário futuro que
 * não seja a OMS) passa INTACTA: a chave vira a própria URI, que é o comportamento de sempre.
 */

/** Mesmo padrão do `regexp_replace` da migration 328 — ver o COMMENT da função lá. */
const RELEASE_SEGMENT_PATTERN = /^.*\/icd\/release\/11\/[^/]+\//;

export function conceptKey(uri: string): string {
  return uri.replace(RELEASE_SEGMENT_PATTERN, '');
}
