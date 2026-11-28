/**
 * confirmClaim — o contrato que o `useClaimConfirm` lê ({ success, worker } | { success: false, error }).
 * Antes o `data` da API ({ worker }) era devolvido cru: sem `success`, o hook tratava o SUCESSO como falha e o
 * modal do código nunca saía, com a ficha já transferida no banco (achado pelo e2e de tela da DP-20). E todo erro
 * virava CANDIDATE_NOT_FOUND. MORRE se o mapeamento sair.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: class { getIdToken = async () => 'tok'; },
}));

import { AuthClaimApiService } from '../AuthClaimApiService';

const input = { verificationSid: 'VE1', otp: '123456', authUid: 'u', email: 'a@b.c' };
const resposta = (status: number, body: unknown) =>
  vi.fn().mockResolvedValue({ status, ok: status < 400, json: async () => body });

describe('AuthClaimApiService.confirmClaim', () => {
  const fetchOriginal = globalThis.fetch;
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { globalThis.fetch = fetchOriginal; });

  it('200 { success, data: { worker } } → { success: true, worker }', async () => {
    globalThis.fetch = resposta(200, { success: true, data: { worker: { id: 'w' } } }) as never;
    expect(await AuthClaimApiService.confirmClaim(input)).toEqual({ success: true, worker: { id: 'w' } });
  });

  it('o corpo do confirm leva só os campos do requisitante (o servidor acha a ficha pelo desafio)', async () => {
    const fetchMock = resposta(200, { success: true, data: { worker: { id: 'w' } } });
    globalThis.fetch = fetchMock as never;
    await AuthClaimApiService.confirmClaim(input);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(Object.keys(body).sort()).toEqual(['authUid', 'email', 'otp', 'verificationSid']);
  });

  it.each(['INVALID_OTP', 'EXPIRED_OTP', 'CANDIDATE_NOT_FOUND', 'NOT_IMPORTABLE'])('400 %s → { success: false, error } (o código certo, não CANDIDATE_NOT_FOUND)', async (code) => {
    globalThis.fetch = resposta(400, { success: false, error: code }) as never;
    expect(await AuthClaimApiService.confirmClaim(input)).toEqual({ success: false, error: code });
  });

  it('erro fora do contrato (500) sobe', async () => {
    globalThis.fetch = resposta(500, { success: false, error: 'boom' }) as never;
    await expect(AuthClaimApiService.confirmClaim(input)).rejects.toThrow('boom');
  });
});
