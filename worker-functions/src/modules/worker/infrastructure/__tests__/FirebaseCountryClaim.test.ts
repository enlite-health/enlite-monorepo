const mockGetUser = jest.fn();
const mockSetCustomUserClaims = jest.fn();

jest.mock('firebase-admin', () => ({
  __esModule: true,
  auth: () => ({ getUser: mockGetUser, setCustomUserClaims: mockSetCustomUserClaims }),
}));

import { FirebaseCountryClaim } from '../FirebaseCountryClaim';

const ABAC = { role: 'worker', account_type: 'worker', pid: 'p-1', areas: { atendimento: ['worker'] } };

describe('FirebaseCountryClaim — merge que preserva os claims de ABAC (D731)', () => {
  beforeEach(() => {
    mockGetUser.mockReset();
    mockSetCustomUserClaims.mockReset().mockResolvedValue(undefined);
  });

  it('T-F0b-42 sem country: grava country POR CIMA de role, account_type, pid e areas', async () => {
    mockGetUser.mockResolvedValueOnce({ customClaims: ABAC }).mockResolvedValueOnce({ customClaims: ABAC })
      .mockResolvedValueOnce({ customClaims: { ...ABAC, country: 'AR' } });
    expect(await new FirebaseCountryClaim().ensureCountry('u1', 'AR')).toBe('provisioned');
    expect(mockSetCustomUserClaims).toHaveBeenCalledTimes(1);
    expect(mockSetCustomUserClaims).toHaveBeenCalledWith('u1', { ...ABAC, country: 'AR' });
  });

  it('T-F0b-42 claim já posto (qa.* ou staff) nunca é trocado: nenhuma escrita', async () => {
    mockGetUser.mockResolvedValue({ customClaims: { ...ABAC, country: 'BR' } });
    expect(await new FirebaseCountryClaim().ensureCountry('u2', 'AR')).toBe('already_set');
    expect(mockSetCustomUserClaims).not.toHaveBeenCalled();
  });

  it('T-F0b-42 corrida: outro escritor regravou sem o country entre o get e o set → grava de novo 1 vez', async () => {
    mockGetUser.mockResolvedValueOnce({ customClaims: undefined }).mockResolvedValueOnce({ customClaims: undefined })
      .mockResolvedValueOnce({ customClaims: { pid: 'p-1' } }).mockResolvedValueOnce({ customClaims: { pid: 'p-1' } });
    expect(await new FirebaseCountryClaim().ensureCountry('u3', 'AR')).toBe('provisioned');
    expect(mockSetCustomUserClaims).toHaveBeenNthCalledWith(1, 'u3', { country: 'AR' });
    expect(mockSetCustomUserClaims).toHaveBeenNthCalledWith(2, 'u3', { pid: 'p-1', country: 'AR' });
  });
});
