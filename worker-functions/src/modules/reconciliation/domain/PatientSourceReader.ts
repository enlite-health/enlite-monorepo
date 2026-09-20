/**
 * PatientSourceReader — porta de leitura de uma fonte externa de pacientes
 * (spec 003, R0/R1).
 *
 * Implementação: AnaCareApiSourceReader (API de paciente do Ana Care — ainda
 * não existe; até existir, a rodada fecha FAILED 'anacare_patient_api_unavailable').
 * ClickUpSourceReader existiu na 003 original mas foi removido (D314 — o
 * gateway de lista do ClickUp saiu do main/stage; ClickUp era fonte em
 * transição, não definitiva).
 *
 * Contrato de completude (H1, cenário 3): quem lê devolve o que a fonte
 * DISSE que tem (expectedCount) e o que conseguiu ler (readCount). A rodada
 * é PARTIAL quando read < expected ou quando houve erro no meio — e nunca é
 * apresentada como completa.
 */

import type { CanonicalPatient } from './CanonicalPatient';
import type { Country, Source } from './enums';

export interface SourceRecord {
  /** id na fonte: task id (ClickUp) ou id/hash de linha (Ana Care). */
  readonly externalId: string;
  readonly canonical: CanonicalPatient;
}

export interface SourceReadResult {
  readonly source: Source;
  readonly country: Country;
  readonly records: readonly SourceRecord[];
  /** O que a fonte declarou ter; null quando ela não informa. */
  readonly expectedCount: number | null;
  readonly readCount: number;
  /** Erros por registro — contagem e ids, NUNCA dado. */
  readonly skipped: readonly { readonly externalId: string; readonly reason: string }[];
  /** Erro fatal (ex.: cabeçalho não casou) — sem linha de dado. */
  readonly fatalError?: string;
}

export interface PatientSourceReader {
  readonly source: Source;
  /** País do dado que esta leitura traz (lex C1 — declarado, nunca default). */
  readonly country: Country;
  read(): Promise<SourceReadResult>;
}
