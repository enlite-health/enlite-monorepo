/**
 * O que este teste trava (ABAC país, achado de QA 16/08): escrever `role` NÃO
 * pode apagar `country`. `setCustomUserClaims` substitui o objeto inteiro —
 * o helper é a única forma de escrever claims justamente para o merge nunca
 * ficar a cargo de cada call site.
 */

const mockGetUser = jest.fn();
const mockSetCustomUserClaims = jest.fn();

jest.mock('firebase-admin', () => ({
  __esModule: true,
  auth: () => ({ getUser: mockGetUser, setCustomUserClaims: mockSetCustomUserClaims }),
}));

import { mergeCustomClaims } from '../mergeCustomClaims';

describe('mergeCustomClaims', () => {
  beforeEach(() => {
    mockGetUser.mockReset();
    mockSetCustomUserClaims.mockReset().mockResolvedValue(undefined);
  });

  it('escrever role PRESERVA country (o bug do auto-provision)', async () => {
    mockGetUser.mockResolvedValue({ customClaims: { role: 'admin', country: 'AR' } });

    await mergeCustomClaims('uid-1', { role: 'recruiter' });

    expect(mockSetCustomUserClaims).toHaveBeenCalledWith('uid-1', { role: 'recruiter', country: 'AR' });
  });

  it('usuário sem claim nenhum: grava só o patch', async () => {
    mockGetUser.mockResolvedValue({ customClaims: undefined });

    await mergeCustomClaims('uid-2', { role: 'admin' });

    expect(mockSetCustomUserClaims).toHaveBeenCalledWith('uid-2', { role: 'admin' });
  });

  it('o patch ganha do valor atual na MESMA chave (troca de país é possível)', async () => {
    mockGetUser.mockResolvedValue({ customClaims: { role: 'admin', country: 'AR' } });

    await mergeCustomClaims('uid-3', { country: 'BR' });

    expect(mockSetCustomUserClaims).toHaveBeenCalledWith('uid-3', { role: 'admin', country: 'BR' });
  });

  it('falha ao ler o usuário propaga — nunca grava às cegas por cima', async () => {
    mockGetUser.mockRejectedValue(new Error('user-not-found'));

    await expect(mergeCustomClaims('uid-4', { role: 'admin' })).rejects.toThrow('user-not-found');
    expect(mockSetCustomUserClaims).not.toHaveBeenCalled();
  });
});
