/**
 * Self-test of the raw-enum leak guard.
 *
 * The guard derives the enum vocabulary from es.json itself (every ALL_CAPS
 * translation key, e.g. CAREGIVER, BOTH, AT_AND_CAREGIVER) and fails any
 * rendered output that shows one of those tokens verbatim — i.e. an enum that
 * bypassed i18n. Tokens whose own label legitimately contains the raw token
 * (e.g. AT → "AT") are excluded to avoid false positives.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import {
  buildRawEnumVocabulary,
  findRawEnumLeaks,
  expectNoRawEnumLeaks,
} from '../rawEnumLeakGuard';

describe('buildRawEnumVocabulary', () => {
  it('pins the core enum values — a label edit that silently unguards one of these must fail here', () => {
    const vocab = buildRawEnumVocabulary();
    for (const token of ['CAREGIVER', 'BOTH', 'SEARCHING', 'AT_AND_CAREGIVER']) {
      expect(vocab.has(token), `${token} deixou de ser vigiado`).toBe(true);
    }
  });

  it('excludes short keys (<3 chars) by construction — AT never enters the vocabulary', () => {
    const vocab = buildRawEnumVocabulary();
    expect(vocab.has('AT')).toBe(false);
  });

  it('excludes tokens that appear verbatim in legitimate label text (DNI, CPF)', () => {
    const vocab = buildRawEnumVocabulary();
    // DNI/CPF são chaves de enum (documentTypes) mas também texto real de labels
    expect(vocab.has('DNI')).toBe(false);
    expect(vocab.has('CPF')).toBe(false);
  });
});

describe('findRawEnumLeaks', () => {
  it('detects a raw enum rendered in the DOM', () => {
    const { container } = render(<div>CASO 798 - CAREGIVER - Sarandí</div>);
    expect(findRawEnumLeaks(container)).toContain('CAREGIVER');
  });

  it('detects raw enums with underscores', () => {
    const { container } = render(<span>AT_AND_CAREGIVER</span>);
    expect(findRawEnumLeaks(container)).toContain('AT_AND_CAREGIVER');
  });

  it('passes translated output', () => {
    const { container } = render(
      <div>CASO 798 - Cuidador/a - Indistinto - Sarandí</div>,
    );
    expect(findRawEnumLeaks(container)).toEqual([]);
  });

  it('does not flag legitimate uppercase words that are not enum keys', () => {
    const { container } = render(
      <div>CASO 798 — DNI 12.345.678 — CID F84.0 — GPS activo</div>,
    );
    expect(findRawEnumLeaks(container)).toEqual([]);
  });
});

describe('expectNoRawEnumLeaks', () => {
  it('throws with the leaked tokens listed', () => {
    const { container } = render(<div>Estado: SEARCHING</div>);
    expect(() => expectNoRawEnumLeaks(container)).toThrowError(/SEARCHING/);
  });

  it('does not throw for clean output', () => {
    const { container } = render(<div>Estado: En búsqueda</div>);
    expect(() => expectNoRawEnumLeaks(container)).not.toThrow();
  });
});
