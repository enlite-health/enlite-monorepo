/**
 * import-patients-from-clickup-guard.ts
 *
 * Parecer do lex (11/09/2026): a carga manual do ClickUp só está autorizada a CRIAR um
 * paciente NOVO — nunca UPDATE. A plataforma é a fonte da verdade (decisão do Gabriel); deixar
 * o ClickUp sobrescrever um registro que a plataforma já tem reintroduziria pela porta dos
 * fundos exatamente o que a remoção do sync automático fechou pela porta da frente.
 *
 * Puro e testável sem banco: recebe a CONTAGEM já lida (`SELECT count(*) FROM patients WHERE
 * clickup_task_id = $1`, rodada pelo script antes de chamar o motor) e devolve a decisão. Quem
 * decide como reportar (console + `process.exit`) é o script, não este arquivo.
 *
 * ── 11/09/2026, achado do gate (BLOCKER) — FAIL-CLOSED em `existingCount === null` ───────────
 * `null` significa "não deu para checar" (o SELECT falhou — banco fora, timeout, conexão
 * recusada). A 1ª versão desta função só recebia `number`, e o SCRIPT tratava `null` como um
 * 3º estado que NÃO chamava esta função — caindo direto para `useCase.execute(task)` sem
 * decisão nenhuma. O gate PROVOU o resultado: SELECT forçado a falhar → o motor rodou mesmo
 * assim → `kind:UPDATED` → sobrescreveu diagnóstico editado na plataforma. Exatamente o UPDATE
 * que esta função existe para impedir, só que pela porta que ninguém tinha fechado ainda.
 * Agora `existingCount` aceita `null`, e a decisão para `null` é a MESMA de "já existe":
 * `allowed: false`. Não há mais um 3º caminho no script que contorne esta função — ver
 * `runSingleTaskApply` abaixo, que é o ÚNICO lugar que decide se `useCase.execute` roda.
 */

export interface NewPatientCheck {
  clickupTaskId: string;
  /** `null` = não deu para checar (SELECT falhou) — tratado como "não é seguro criar", nunca
   *  como "zero"/"paciente novo" (F19: ausência de leitura não é sucesso). */
  existingCount: number | null;
}

export type NewPatientDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Mensagem EXATA pedida pelo lex — não parafrasear: quem lê o stdout (inclusive dentro de uma
 * sessão do Claude) precisa reconhecer a recusa sem ambiguidade.
 */
export const PATIENT_ALREADY_EXISTS_MESSAGE =
  'paciente já existe na plataforma — UPDATE via ClickUp proibido (plataforma é a fonte, decisão 11/09)';

/**
 * Mensagem fixa para o caso `existingCount === null` — nunca leva detalhe do erro de banco
 * (poderia vazar string de conexão, nome de host, etc.). Diferente de
 * `PATIENT_ALREADY_EXISTS_MESSAGE` de propósito: quem lê o stdout precisa distinguir "recusei
 * porque confirmei que existe" de "recusei porque não consegui checar" — o 2º pede "tente de
 * novo", o 1º não.
 */
export const EXISTING_CHECK_FAILED_MESSAGE =
  'não foi possível confirmar que o paciente é novo (falha ao consultar o banco) — abortado por segurança, tente novamente';

export function decideIfNewPatientAllowed(check: NewPatientCheck): NewPatientDecision {
  if (check.existingCount === null) {
    return { allowed: false, reason: EXISTING_CHECK_FAILED_MESSAGE };
  }
  if (check.existingCount > 0) {
    return { allowed: false, reason: PATIENT_ALREADY_EXISTS_MESSAGE };
  }
  return { allowed: true };
}

export type ApplyOutcome<T> =
  | { aborted: true; reason: string }
  | { aborted: false; result: T };

/**
 * O ÚNICO ponto de decisão entre "abortar" e "chamar o motor" no caminho `--apply`. Extraído
 * para ser testável isoladamente: a prova de que "motor nunca roda quando a decisão é recusar"
 * não pode depender de rodar o script inteiro (I/O de rede/DB) — este função é síncrona na
 * decisão e só invoca `callEngine` quando `decision.allowed === true`, nunca antes.
 */
export async function runSingleTaskApply<T>(
  decision: NewPatientDecision,
  callEngine: () => Promise<T>,
): Promise<ApplyOutcome<T>> {
  if (!decision.allowed) {
    return { aborted: true, reason: decision.reason };
  }
  const result = await callEngine();
  return { aborted: false, result };
}
