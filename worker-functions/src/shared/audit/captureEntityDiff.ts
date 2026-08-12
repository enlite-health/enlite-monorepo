/**
 * src/shared/audit/captureEntityDiff.ts
 *
 * Função pura que compara dois snapshots de uma entidade e retorna apenas
 * os campos que realmente mudaram, filtrados pela lista de campos permitidos.
 *
 * Regras:
 * - Apenas campos presentes em `allowedFields` são inspecionados.
 * - Comparação por igualdade estrita (===). Para objetos/arrays, compara via
 *   JSON.stringify — suficiente para detecção de diff em campos JSONB.
 * - Campos cujo valor é idêntico em `before` e `after` são omitidos.
 *
 * @param before        - Snapshot da entidade antes da mutação (objeto plano).
 * @param after         - Snapshot da entidade após a mutação (objeto plano).
 * @param allowedFields - Whitelist de campos a inspecionar.
 * @returns Array de { field, before, after } apenas para campos que mudaram.
 */

import type { EntityFieldDiff } from './types';

export function captureEntityDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  allowedFields: readonly string[],
): EntityFieldDiff[] {
  const diffs: EntityFieldDiff[] = [];

  for (const field of allowedFields) {
    const bVal = before[field];
    const aVal = after[field];

    const changed =
      bVal === aVal
        ? false
        : typeof bVal === 'object' || typeof aVal === 'object'
          ? JSON.stringify(bVal) !== JSON.stringify(aVal)
          : bVal !== aVal;

    if (changed) {
      diffs.push({ field, before: bVal, after: aVal });
    }
  }

  return diffs;
}
