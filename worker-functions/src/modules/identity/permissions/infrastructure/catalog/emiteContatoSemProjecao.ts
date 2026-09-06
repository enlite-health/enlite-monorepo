/**
 * Deny-when-undeclared estendido a CAMPO — condição C4 do veredito do `lex`.
 *
 * ── Por que isto não é o scanner de rota com outro nome ─────────────────────
 * O deny-by-default de ROTA funciona porque o Express enumera rotas em runtime
 * (`_router.stack`): dá para perguntar a uma estrutura real "quem existe?" e
 * cruzar com quem declarou. CAMPO não tem esse registro — um handler emite o
 * objeto que ele montar, e não existe `scanEmittedFields`. Então o eixo aqui é
 * o ARQUIVO: quem cita coluna de PII de prestador E escreve resposta HTTP tem
 * de passar pela projeção.
 *
 * ⚠️ FALSOS NEGATIVOS, DECLARADOS (D173 — falso negativo não é regressão, mas
 * calar sobre ele é). Isto detecta REFERÊNCIA, não FLUXO:
 *   1. arquivo que importe a projeção para OUTRA coisa e emita PII à parte passa;
 *   2. use case que MONTA o corpo e devolve ao controller não casa `res.json`,
 *      então some da varredura (`GetFunnelTableUseCase` é exatamente esse caso);
 *   3. coluna de PII alcançada por `SELECT *` / `jp.*` não aparece como nome;
 *   4. PII vinda de outra tabela com outro nome de coluna não está na lista.
 * O que fecha 2 e 3 é o canário em runtime (`guardaVazamentoPrestador`), não
 * este arquivo. Os dois juntos, nenhum sozinho.
 *
 * A função recebe CONTEÚDO, e não caminho, de propósito: é o que permite o
 * controle POSITIVO com alvo sintético (D157) — régua de controle não detecta
 * instrumento morto, só a positiva detecta.
 */

/** Colunas cifradas e colunas de texto claro que carregam identidade de prestador. */
export const COLUNAS_DE_PRESTADOR = [
  'first_name_encrypted',
  'last_name_encrypted',
  'whatsapp_phone_encrypted',
  'document_number_encrypted',
  'birth_date_encrypted',
  'address_encrypted',
  'profile_photo_url_encrypted',
  'worker_raw_name',
  'worker_raw_phone',
] as const;

const RE_COLUNA = new RegExp(COLUNAS_DE_PRESTADOR.join('|'));
/** `res.json(...)` e `res.status(...).json(...)` — a emissão de resposta HTTP. */
const RE_EMISSAO = /res\.(status\([^)]*\)\.)?json\(/;
/**
 * As DUAS projeções reconhecidas: `projectWorkerFields` (F2/C3, campo a campo) e a ficha por
 * container (`workerContainerReadsOf`, D286 fase 2 — `AdminWorkersDetailBuilder`). Qualquer
 * outra forma de "decidir antes do KMS" é desconhecida da catraca e é acusada.
 */
const RE_PROJECAO = /projectWorkerFields|workerContainerReadsOf/;

export interface Veredito {
  citaColuna: boolean;
  emiteResposta: boolean;
  passaPelaProjecao: boolean;
  /** `true` quando cita PII, responde HTTP e NÃO projeta. */
  emiteContatoSemProjecao: boolean;
}

export function analisar(conteudo: string): Veredito {
  const citaColuna = RE_COLUNA.test(conteudo);
  const emiteResposta = RE_EMISSAO.test(conteudo);
  const passaPelaProjecao = RE_PROJECAO.test(conteudo);
  return {
    citaColuna,
    emiteResposta,
    passaPelaProjecao,
    emiteContatoSemProjecao: citaColuna && emiteResposta && !passaPelaProjecao,
  };
}
