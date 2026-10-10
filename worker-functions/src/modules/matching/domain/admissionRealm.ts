/**
 * admissionRealm — a DONA do conceito "esta reunião de admissão pode entrar no caminho PAGO?" (spec 050, R-18/R-20).
 *
 * Caminho pago = Meet API, Tactiq, cofre, Vertex e Twilio. Quem decide NÃO é cada fila com o seu `if (isTest)`: é esta função.
 * Fila, serviço e log leem o `realm` que ela devolve; é proibido recalcular a mesma coisa em outro lugar.
 *
 *  - `real`   — paciente de verdade: segue o caminho pago.
 *  - `test`   — paciente `is_test`: NUNCA chega ao caminho pago (a fila grava `skipped_test` e segue adiante).
 *  - `ensaio` — reunião de paciente de teste LIBERADA por uma pessoa, com prazo (R-19). Só passa a ser produzido na fase
 *               seguinte, que acrescenta um campo opcional em `AdmissionRealmFacts`; os chamadores não mudam.
 */
export type AdmissionRealm = 'real' | 'test' | 'ensaio';

export interface AdmissionRealmFacts {
  /** `patients.is_test` do paciente da reunião. */
  isTest: boolean;
}

export function admissionRealm(facts: AdmissionRealmFacts): AdmissionRealm {
  return facts.isTest ? 'test' : 'real';
}

/** `test` fica fora do caminho pago. (`ensaio` e `real` entram.) */
export const isBlockedFromPaidPath = (realm: AdmissionRealm): boolean => realm === 'test';

/** Tipo do evento da trilha que registra a reunião `test` que a fila pulou. */
export const SKIPPED_TEST_EVENT = 'skipped_test';

/** Motivo do evento `skipped_test` por etapa da reunião (a trilha guarda UM por etapa). */
export type SkippedTestStage = 'post_call' | 'import';
