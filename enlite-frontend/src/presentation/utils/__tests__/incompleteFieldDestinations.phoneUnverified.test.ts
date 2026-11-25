import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkerProgressResponse } from '@infrastructure/http/WorkerApiService';
import { destinationFor, labelKeyFor, phoneStepOf, KNOWN_TOKENS } from '../incompleteFieldDestinations';
import { getStep1Progress } from '../workerProgressValidation';
import { buildPendingRows } from '../pendingRows';
import { useWorkerProfileProgress } from '@presentation/hooks/useWorkerProfileProgress';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'es' } }),
}));

const LOCALES = join(__dirname, '../../../infrastructure/i18n/locales');
const es = JSON.parse(readFileSync(join(LOCALES, 'es.json'), 'utf8'));
const pt = JSON.parse(readFileSync(join(LOCALES, 'pt-BR.json'), 'utf8'));
const lookup = (dict: Record<string, unknown>, key: string): unknown =>
  key.split('.').reduce<unknown>((acc, k) => (acc as Record<string, unknown> | undefined)?.[k], dict);

const base: WorkerProgressResponse = {
  id: 'w1', authUid: 'a1', email: 'a@b.c', country: 'AR', timezone: 'UTC', createdAt: '', updatedAt: '',
};
const fichaNovaSemVerificar = { ...base, missingFields: ['phone_unverified'], phoneVerification: { state: 'unverified' as const, phoneMasked: '+54 ***', verifiedAt: null } };
const fichaLegada = { ...base, missingFields: [] as string[], phoneVerification: { state: 'unverified' as const, phoneMasked: '+54 ***', verifiedAt: null } };

describe('phone_unverified no passo a passo da web (emenda 077 §7.4)', () => {
  it('T-F3c-147 phone_unverified tem destino e rótulo em es e pt-BR', () => {
    expect(KNOWN_TOKENS).toContain('phone_unverified');
    expect(destinationFor('phone_unverified')).toEqual({ tab: 'general', focus: 'phone' });
    const key = labelKeyFor('phone_unverified');
    expect(key).toBeTruthy();
    expect(typeof lookup(es, key as string)).toBe('string');
    expect(typeof lookup(pt, key as string)).toBe('string');
    expect(lookup(es, key as string)).not.toBe(lookup(pt, key as string));
  });

  it('T-F3c-147 ficha nova sem verificar: item pendente e conta no total', () => {
    expect(phoneStepOf(fichaNovaSemVerificar)).toEqual({ status: 'pending', badge: 'unverified' });
    expect(buildPendingRows(['phone_unverified']).map((r) => r.tab)).toEqual(['general']);
    const total = getStep1Progress({ ...base, missingFields: [] }).totalFields;
    const p = getStep1Progress(fichaNovaSemVerificar);
    expect(p.totalFields).toBe(total);
    expect(p.completedFields).toBe(total - 1);
    const { result } = renderHook(() => useWorkerProfileProgress(fichaNovaSemVerificar));
    const step = result.current.progress.sections[0].steps.find((s) => s.id === 'phone');
    expect(step?.status).toBe('pending');
    expect(result.current.isComplete).toBe(false);
  });

  it('T-F3c-147 ficha legada (sem o item, state unverified): passo pronto com selo "Sin verificar"', () => {
    expect(phoneStepOf(fichaLegada)).toEqual({ status: 'ready', badge: 'unverified' });
    expect(buildPendingRows([])).toEqual([]);
    const { result } = renderHook(() => useWorkerProfileProgress(fichaLegada));
    const step = result.current.progress.sections[0].steps.find((s) => s.id === 'phone');
    expect(step?.status).toBe('completed');
    expect(result.current.isComplete).toBe(true);
    // "não sei" nunca vira pronto
    expect(phoneStepOf({ ...base, missingFields: null }).status).toBe('unknown');
  });

  it('T-F3c-147 as chaves i18n do passo existem nos 2 idiomas', () => {
    for (const key of ['phoneVerification.stepLabel', 'phoneVerification.pendingLabel', 'phoneVerification.badge.unverified', 'phoneVerification.badge.verified', 'phoneVerification.badge.noPhone', 'phoneVerification.verifyButton']) {
      expect(typeof lookup(es, key), `es ${key}`).toBe('string');
      expect(typeof lookup(pt, key), `pt-BR ${key}`).toBe('string');
    }
  });
});
