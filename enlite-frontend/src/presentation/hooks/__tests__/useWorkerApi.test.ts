import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useWorkerApi } from '../useWorkerApi';
import { useAuth } from '@presentation/hooks/useAuth';

vi.mock('@presentation/hooks/useAuth', () => ({
  useAuth: vi.fn(),
}));

vi.mock('@infrastructure/http/WorkerApiService', () => ({
  WorkerApiService: {
    getProgress: vi.fn(),
    initWorker: vi.fn(),
    saveStep: vi.fn(),
    saveGeneralInfo: vi.fn(),
    saveServiceArea: vi.fn(),
    getAvailability: vi.fn(),
    saveAvailability: vi.fn(),
  },
}));

/**
 * Regressão do bug "campos do perfil somem".
 *
 * Causa raiz: o Firebase dispara onAuthStateChanged várias vezes (restauração
 * de sessão, refresh de token) e o FirebaseAuthService cria um OBJETO `user`
 * novo a cada vez. Quando os callbacks de useWorkerApi dependiam de `[user]`,
 * cada novo objeto recriava getProgress → o useEffect do form re-rodava →
 * reset() zerava os campos já carregados.
 *
 * O fix passou a depender de `user?.id` (primitivo). Mesmo `id` → MESMA
 * referência de callback, mesmo com objeto `user` novo.
 */
describe('useWorkerApi — estabilidade dos callbacks (regressão "campos somem")', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('mantém a MESMA referência de getProgress quando o objeto user muda mas o id é o mesmo', () => {
    const userV1 = { id: 'uid-123', email: 'w@test.com', name: 'W' };
    // Mesmo uid/email, OBJETO novo — exatamente o que o Firebase emite a cada
    // onAuthStateChanged.
    const userV2 = { id: 'uid-123', email: 'w@test.com', name: 'W' };
    expect(userV1).not.toBe(userV2); // sanity: são objetos diferentes

    vi.mocked(useAuth).mockReturnValue({ user: userV1 } as any);
    const { result, rerender } = renderHook(() => useWorkerApi());
    const getProgressV1 = result.current.getProgress;
    const initWorkerV1 = result.current.initWorker;

    // Firebase re-emite: novo objeto user, mesmo id.
    vi.mocked(useAuth).mockReturnValue({ user: userV2 } as any);
    rerender();

    expect(result.current.getProgress).toBe(getProgressV1);
    expect(result.current.initWorker).toBe(initWorkerV1);
  });

  it('recria os callbacks quando o id do usuário realmente muda (troca de conta)', () => {
    vi.mocked(useAuth).mockReturnValue({
      user: { id: 'uid-A', email: 'a@test.com', name: 'A' },
    } as any);
    const { result, rerender } = renderHook(() => useWorkerApi());
    const getProgressA = result.current.getProgress;

    vi.mocked(useAuth).mockReturnValue({
      user: { id: 'uid-B', email: 'b@test.com', name: 'B' },
    } as any);
    rerender();

    expect(result.current.getProgress).not.toBe(getProgressA);
  });
});
