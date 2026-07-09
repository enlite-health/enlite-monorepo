/**
 * Regra de negócio "Equipe Armada = quadro completo".
 *
 * Um caso (job_posting) está ARMADO quando tem titulares e substitutos
 * SELECIONADOS suficientes. As contagens vêm de `encuadres` com
 * resultado='SELECCIONADO' e o papel (`encuadres.role`, migration 142):
 *   - TITULAR        → titular
 *   - RAPID_RESPONSE → substituto / backup
 *
 * Buckets honestos (sem 0 falso — ver dono do produto):
 *   - SEM_CONFIG:              providers_needed não-numérico/NULL.
 *   - PENDENTE_CLASSIFICACAO:  ≥1 SELECCIONADO mas nenhum com papel setado
 *                              (não dá pra julgar armada durante o rollout).
 *   - ARMADA:                  numérico, classificável, titular ≥ exigidos e
 *                              substituto ≥ REQUIRED_SUBSTITUTES.
 *   - POR_ARMAR:               numérico, classificável e não armada.
 *
 * Toda a lógica é pura (sem I/O) para ser 100% coberta por unit test.
 */

/** Papel do encuadre selecionado (espelha o CHECK da migration 142). */
export type EncuadreRole = 'TITULAR' | 'RAPID_RESPONSE';

/** Substitutos exigidos por caso — constante de domínio (não é coluna). */
export const REQUIRED_SUBSTITUTES = 10;

export type ArmedCaseBucket =
  | 'ARMADA'
  | 'POR_ARMAR'
  | 'SEM_CONFIG'
  | 'PENDENTE_CLASSIFICACAO';

export interface ArmedCaseInput {
  /** job_postings.providers_needed (TEXT) — cru, cast defensivo aqui dentro. */
  providersNeeded: string | null;
  /** encuadres SELECCIONADO (qualquer papel) do caso. */
  selectedTotal: number;
  /** encuadres SELECCIONADO com papel setado (role IS NOT NULL). */
  selectedWithRole: number;
  /** DISTINCT worker_id SELECCIONADO com role='TITULAR'. */
  selecTitular: number;
  /** DISTINCT worker_id SELECCIONADO com role='RAPID_RESPONSE'. */
  selecSubstituto: number;
}

/**
 * Cast defensivo de providers_needed. Só inteiro puro conta como configuração;
 * NULL, vazio ou não-numérico → null (= SEM_CONFIG).
 */
export function parseTitularesExigidos(providersNeeded: string | null): number | null {
  if (providersNeeded == null) return null;
  const trimmed = providersNeeded.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number.parseInt(trimmed, 10);
}

/** Classifica um caso num único bucket honesto. */
export function classifyArmedCase(input: ArmedCaseInput): ArmedCaseBucket {
  const titularesExigidos = parseTitularesExigidos(input.providersNeeded);
  if (titularesExigidos === null) return 'SEM_CONFIG';

  // Rollout do papel: há selecionados, mas nenhum classificado ainda.
  if (input.selectedTotal > 0 && input.selectedWithRole === 0) {
    return 'PENDENTE_CLASSIFICACAO';
  }

  const armada =
    input.selecTitular >= titularesExigidos &&
    input.selecSubstituto >= REQUIRED_SUBSTITUTES;

  return armada ? 'ARMADA' : 'POR_ARMAR';
}
