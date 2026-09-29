import { describe, it, expect, vi } from 'vitest';
import type { TFunction } from 'i18next';
import { workerLabel } from '../workerLabel';

describe('workerLabel', () => {
  it('com displayName → o próprio nome, sem chamar o i18n', () => {
    const t = vi.fn() as unknown as TFunction;
    expect(workerLabel(t, 'aaaaaaaa-0000-0000-0000-123456789abc', 'Nome QA')).toBe('Nome QA');
    expect(t).not.toHaveBeenCalled();
  });

  it('displayName null → chave unnamedWorker com os 8 últimos caracteres do id', () => {
    const t = vi.fn((key: string, opts: { shortId: string }) => `${key}:${opts.shortId}`) as unknown as TFunction;
    expect(workerLabel(t, 'aaaaaaaa-0000-0000-0000-123456789abc', null)).toBe(
      'admin.patients.detail.serviceTeam.unnamedWorker:56789abc',
    );
  });
});
