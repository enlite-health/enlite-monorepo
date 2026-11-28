import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useClaimConfirm } from './useClaimConfirm';

const mockConfirmClaim = vi.fn();
vi.mock('@infrastructure/http/AuthClaimApiService', () => ({
  AuthClaimApiService: { confirmClaim: (...a: unknown[]) => mockConfirmClaim(...a) },
}));

async function confirmWith(lgpdOptIn?: boolean) {
  const { result } = renderHook(() => useClaimConfirm('VE_1', 'uid-1', 'a@exemplo.test', lgpdOptIn));
  await act(async () => { await result.current.confirm(' 123456 '); });
  return mockConfirmClaim.mock.calls[0][0] as Record<string, unknown>;
}

describe('useClaimConfirm: aceite explícito', () => {
  beforeEach(() => {
    mockConfirmClaim.mockReset();
    mockConfirmClaim.mockResolvedValue({ success: true, worker: { id: 'w1' } });
  });

  it('caixa marcada: o corpo do confirm leva lgpdOptIn:true', async () => {
    expect(await confirmWith(true)).toMatchObject({ verificationSid: 'VE_1', otp: '123456', lgpdOptIn: true });
  });

  it('o corpo do confirm leva só os campos do requisitante (a ficha o servidor acha pelo desafio)', async () => {
    expect(Object.keys(await confirmWith(true)).sort()).toEqual(['authUid', 'email', 'lgpdOptIn', 'otp', 'verificationSid']);
  });

  it('sem caixa (login Google, perfil): o corpo NÃO leva lgpdOptIn', async () => {
    expect(await confirmWith(undefined)).not.toHaveProperty('lgpdOptIn');
    mockConfirmClaim.mockClear();
    expect(await confirmWith(false)).not.toHaveProperty('lgpdOptIn');
  });
});
