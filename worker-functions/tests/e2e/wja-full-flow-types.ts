/**
 * wja-full-flow-types.ts
 *
 * Tipos auxiliares para wja-full-flow.e2e.test.ts.
 * Centraliza extensões do ResponseBlock para evitar `as unknown as X` inline.
 */

import type { ResponseBlock } from '../fixtures/talentumPayload';

/**
 * ResponseBlock estendido com campos de ANALYZED (score + statusLabel).
 * Usado nos webhooks T5.b e RECHAZAR auto.
 */
export type AnalyzedBlock = ResponseBlock & {
  score: number;
  statusLabel: 'QUALIFIED' | 'NOT_QUALIFIED' | 'IN_DOUBT' | 'PENDING';
};
