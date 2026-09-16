/**
 * IdentityMatcher — "este registro de fonte é esta pessoa?" (spec 003, R2).
 *
 * Ordem: DOCUMENT (tipo + número iguais) > NAME_BIRTHDATE (nome normalizado +
 * data de nascimento) > AMBIGUOUS (só um dos dois bate) > NONE.
 *
 * Regras que a spec exige e o teste cobre:
 *  - bate em PARTE → AMBIGUOUS, com o candidato. NUNCA funde sozinho (H1 c.2).
 *  - par DENIED pelo Gabriel nunca volta a AUTO pela chave (H3 c.4).
 *  - duplicata interna (dois candidatos distintos batendo a mesma chave forte)
 *    → AMBIGUOUS, não "nos dois" (caso de borda D57).
 *
 * Puro: sem I/O. Quem chama traz os candidatos.
 */

import type { MatchKey } from './enums';

export interface IdentityProbe {
  readonly firstName: string | null;
  readonly lastName: string | null;
  /** ISO `YYYY-MM-DD` */
  readonly birthDate: string | null;
  readonly documentType: string | null;
  readonly documentNumber: string | null;
}

export interface IdentityCandidate extends IdentityProbe {
  readonly patientId: string;
}

export type MatchOutcome =
  | { readonly kind: 'MATCH'; readonly matchKey: Extract<MatchKey, 'EXTERNAL_ID' | 'DOCUMENT' | 'NAME_BIRTHDATE'>; readonly patientId: string }
  | { readonly kind: 'AMBIGUOUS'; readonly candidatePatientId: string; readonly reason: AmbiguityReason }
  | { readonly kind: 'NONE' };

export type AmbiguityReason =
  | 'NAME_MATCH_BIRTHDATE_DIFFERS'
  | 'BIRTHDATE_MATCH_NAME_DIFFERS'
  | 'DOCUMENT_MATCH_NAME_DIFFERS'
  | 'MULTIPLE_CANDIDATES';

/** lower + sem acento + sem pontuação + espaços colapsados. */
export function normalizeName(first: string | null, last: string | null): string | null {
  const full = [first ?? '', last ?? ''].join(' ');
  const norm = full
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return norm || null;
}

/**
 * Normaliza só pelo NÚMERO do documento (F14 — 59/66 pacientes da amostra têm
 * `documentType` vazio; a chave composta `TIPO:NUMERO` original nunca batia
 * entre um registro com tipo e outro sem). O tipo não entra na chave — dois
 * registros com o mesmo número e tipos diferentes (`''` vs `'TI'`) casam.
 */
export function normalizeDocument(_type: string | null, number: string | null): string | null {
  if (!number) return null;
  const digits = number.replace(/[^\p{L}\p{N}]/gu, '').toUpperCase();
  if (!digits) return null;
  return digits;
}

export class IdentityMatcher {
  /**
   * @param deniedPatientIds pessoas que o Gabriel já disse "não é esta" para
   *        este registro — ficam fora de qualquer match automático.
   */
  match(
    probe: IdentityProbe,
    candidates: readonly IdentityCandidate[],
    deniedPatientIds: ReadonlySet<string> = new Set(),
  ): MatchOutcome {
    const pool = candidates.filter(c => !deniedPatientIds.has(c.patientId));
    const pDoc = normalizeDocument(probe.documentType, probe.documentNumber);
    const pName = normalizeName(probe.firstName, probe.lastName);
    const pBirth = probe.birthDate;

    // 1. chave forte: documento
    if (pDoc) {
      const byDoc = pool.filter(c => normalizeDocument(c.documentType, c.documentNumber) === pDoc);
      if (byDoc.length > 1) {
        return { kind: 'AMBIGUOUS', candidatePatientId: byDoc[0].patientId, reason: 'MULTIPLE_CANDIDATES' };
      }
      if (byDoc.length === 1) {
        const c = byDoc[0];
        const cName = normalizeName(c.firstName, c.lastName);
        // documento igual mas nome claramente outro → pergunta, não funde
        if (pName && cName && pName !== cName && !sharesToken(pName, cName)) {
          return { kind: 'AMBIGUOUS', candidatePatientId: c.patientId, reason: 'DOCUMENT_MATCH_NAME_DIFFERS' };
        }
        return { kind: 'MATCH', matchKey: 'DOCUMENT', patientId: c.patientId };
      }
    }

    // 2. chave fraca: nome + nascimento
    if (pName && pBirth) {
      const both = pool.filter(c => normalizeName(c.firstName, c.lastName) === pName && c.birthDate === pBirth);
      if (both.length > 1) {
        return { kind: 'AMBIGUOUS', candidatePatientId: both[0].patientId, reason: 'MULTIPLE_CANDIDATES' };
      }
      if (both.length === 1) {
        return { kind: 'MATCH', matchKey: 'NAME_BIRTHDATE', patientId: both[0].patientId };
      }
    }

    // 3. bate em parte → ambíguo
    if (pName) {
      const byName = pool.find(c => normalizeName(c.firstName, c.lastName) === pName);
      if (byName) {
        return { kind: 'AMBIGUOUS', candidatePatientId: byName.patientId, reason: 'NAME_MATCH_BIRTHDATE_DIFFERS' };
      }
    }
    if (pBirth && pName) {
      const byBirth = pool.find(c => c.birthDate === pBirth && sharesToken(pName, normalizeName(c.firstName, c.lastName)));
      if (byBirth) {
        return { kind: 'AMBIGUOUS', candidatePatientId: byBirth.patientId, reason: 'BIRTHDATE_MATCH_NAME_DIFFERS' };
      }
    }

    return { kind: 'NONE' };
  }
}

/** Dois nomes normalizados compartilham ao menos um token com ≥ 3 letras. */
function sharesToken(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const ta = new Set(a.split(' ').filter(t => t.length >= 3));
  return b.split(' ').some(t => t.length >= 3 && ta.has(t));
}
