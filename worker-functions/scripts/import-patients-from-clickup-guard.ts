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
 */

export interface NewPatientCheck {
  clickupTaskId: string;
  existingCount: number;
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

export function decideIfNewPatientAllowed(check: NewPatientCheck): NewPatientDecision {
  if (check.existingCount > 0) {
    return { allowed: false, reason: PATIENT_ALREADY_EXISTS_MESSAGE };
  }
  return { allowed: true };
}
