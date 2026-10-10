/**
 * admissionRealm — a DONA do conceito "esta reunião de admissão pode entrar no caminho PAGO?" (spec 050, R-18/R-20).
 *
 * Caminho pago = Meet API, Tactiq, cofre, Vertex e Twilio. Quem decide NÃO é cada fila com o seu `if (isTest)`: é esta função.
 * Fila, serviço e log leem o `realm` que ela devolve; é proibido recalcular a mesma coisa em outro lugar.
 *
 *  - `real`   — paciente de verdade: segue o caminho pago.
 *  - `test`   — paciente `is_test`: NUNCA chega ao caminho pago (a fila grava `skipped_test` e segue adiante).
 *  - `ensaio` — reunião de paciente de teste LIBERADA por uma pessoa, com prazo (R-19, spec 050 F3): a liberação vigente
 *               (`rehearsalUntil` no futuro) faz o caminho pago rodar; expirada, volta a `test`. A transcrição de `ensaio`
 *               vai ao bucket de ensaio, nunca ao cofre de 5 anos (R-29) — quem escolhe o destino é `transcriptDestination`.
 */
export type AdmissionRealm = 'real' | 'test' | 'ensaio';

export interface AdmissionRealmFacts {
  /** `patients.is_test` do paciente da reunião. */
  isTest: boolean;
  /**
   * Fim da liberação MAIS RECENTE desta reunião (evento `paid_rehearsal_released`); `null`/ausente = nunca liberada.
   * Só importa para paciente `is_test`: paciente real nunca tem ensaio.
   */
  rehearsalUntil?: Date | null;
  /** O relógio de quem decide (injetável em teste). Padrão: agora. */
  now?: Date;
}

export function admissionRealm(facts: AdmissionRealmFacts): AdmissionRealm {
  if (!facts.isTest) return 'real';
  const now = facts.now ?? new Date();
  return facts.rehearsalUntil && facts.rehearsalUntil.getTime() > now.getTime() ? 'ensaio' : 'test';
}

/** Tipo do evento da trilha que registra a liberação (R-19): `ref = { actorUid, expiresAt }`. Só ids e carimbo. */
export const PAID_REHEARSAL_RELEASED_EVENT = 'paid_rehearsal_released';

/** Prazo da liberação do ensaio pago (R-19): 48 h. */
export const PAID_REHEARSAL_TTL_MS = 48 * 60 * 60 * 1000;

/** Onde a transcrição desta reunião é gravada (R-29). `none` = `test` não chega a gravar. */
export type TranscriptDestination = 'vault' | 'rehearsal' | 'none';

/** O dono único da escolha do destino: lê o `realm`, nunca recalcula `is_test`. */
export function transcriptDestination(realm: AdmissionRealm): TranscriptDestination {
  if (realm === 'real') return 'vault';
  if (realm === 'ensaio') return 'rehearsal';
  return 'none';
}

/** Motivo gravado na trilha quando `ensaio` não tem bucket de ensaio configurado (fail-closed, antes de qualquer chamada paga). */
export const REHEARSAL_BUCKET_MISSING = 'rehearsal_bucket_missing';

/** `test` fica fora do caminho pago. (`ensaio` e `real` entram.) */
export const isBlockedFromPaidPath = (realm: AdmissionRealm): boolean => realm === 'test';

/** Tipo do evento da trilha que registra a reunião `test` que a fila pulou. */
export const SKIPPED_TEST_EVENT = 'skipped_test';

/** Motivo do evento `skipped_test` por etapa da reunião (a trilha guarda UM por etapa). */
export type SkippedTestStage = 'post_call' | 'import';
