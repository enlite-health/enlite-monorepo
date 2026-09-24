import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * F2 (spec 026, `troca-de-grupo-simulado-com-feedback-e-cache-versionado`) —
 * `startSimulation`/`endSimulation` passam a CONFIRMAR a troca: depois do
 * POST/DELETE, refazem `fetchAuthz()` em loop (até `CONFIRM_MAX_ATTEMPTS=5`,
 * a cada `CONFIRM_INTERVAL_MS=1000`) até o contrato refletir a mudança, e só
 * então `switching` volta a `null` — é o que o `GroupSwitchOverlay` (tela
 * cheia) lê. Molde: `adminAuthStore.simulation.test.ts` (mesmo mock de
 * FirebaseAuthService/AdminApiService/AdminAuthzApiService) + `vi.useFakeTimers()`
 * no padrão de `inviteProgressStore.test.ts` (o `delay()` interno usa `setTimeout`).
 */

vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({
    signInWithEmail: vi.fn(),
    signInWithGoogle: vi.fn(),
    logout: vi.fn().mockResolvedValue(undefined),
    onAuthStateChanged: vi.fn(),
    getIdToken: vi.fn().mockResolvedValue('tok'),
    forceRefreshToken: vi.fn().mockResolvedValue(undefined),
  })),
}));
vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: { getProfile: vi.fn().mockResolvedValue({ firebaseUid: 'u1' }) },
}));

const getMyAuthz = vi.fn();
const startSimulationApi = vi.fn();
const endSimulationApi = vi.fn();
vi.mock('@infrastructure/http/AdminAuthzApiService', () => ({
  AdminAuthzApiService: {
    getMyAuthz: (...a: unknown[]) => getMyAuthz(...a),
    startSimulation: (...a: unknown[]) => startSimulationApi(...a),
    endSimulation: (...a: unknown[]) => endSimulationApi(...a),
    listSimulatableGroups: vi.fn(),
  },
}));

import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

type StoreComTroca = ReturnType<typeof useAdminAuthStore.getState> & {
  switching: { kind: 'start'; groupId: string; groupName: string } | { kind: 'end' } | null;
  switchError: 'unconfirmed' | null;
  startSimulation: (groupId: string, groupName: string) => Promise<void>;
  endSimulation: () => Promise<void>;
};

const estado = (): StoreComTroca => useAdminAuthStore.getState() as unknown as StoreComTroca;

const SIMULACAO = {
  id: 's1',
  groupId: 'g-recl',
  groupName: 'Reclutamiento - AG',
  startedAt: '2026-09-24T10:00:00.000Z',
  expiresAt: '2026-09-24T14:00:00.000Z',
};

const semSimulacao: AuthzContract = {
  uid: 'u1',
  tenantId: 't',
  status: 'ACTIVE',
  permissions: [],
  countries: ['AR'],
  groups: [],
  features: {},
  enforcement: 'on',
  canSimulate: true,
  simulation: null,
};

const comSimulacao: AuthzContract = { ...semSimulacao, simulation: SIMULACAO };

describe('adminAuthStore — confirmação da troca de grupo (F2, overlay de tela cheia)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getMyAuthz.mockReset();
    startSimulationApi.mockReset();
    endSimulationApi.mockReset();
    useAdminAuthStore.setState({
      user: null,
      adminProfile: null,
      isAuthenticated: false,
      authz: null,
      authzStatus: 'idle',
      simulationExpired: false,
      switching: null,
      switchError: null,
    } as never);
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  describe('startSimulation(groupId, groupName)', () => {
    it('(a) confirma no 1º fetchAuthz — switching volta a null sem erro, 1 chamada', async () => {
      useAdminAuthStore.setState({ authz: semSimulacao, authzStatus: 'ready' });
      startSimulationApi.mockResolvedValue(SIMULACAO);
      getMyAuthz.mockResolvedValue(comSimulacao);

      const promise = estado().startSimulation('g-recl', 'Reclutamiento - AG');
      // logo após chamar, a troca está em curso — é o que o overlay lê.
      expect(estado().switching).toEqual({ kind: 'start', groupId: 'g-recl', groupName: 'Reclutamiento - AG' });

      await promise;

      expect(getMyAuthz).toHaveBeenCalledTimes(1);
      expect(estado().switching).toBeNull();
      expect(estado().switchError).toBeNull();
      expect(estado().authz?.simulation).toEqual(SIMULACAO);
    });

    it('(b) confirma no 3º fetchAuthz (2 stale + 1 certo) — sem erro, 3 chamadas', async () => {
      useAdminAuthStore.setState({ authz: semSimulacao, authzStatus: 'ready' });
      startSimulationApi.mockResolvedValue(SIMULACAO);
      getMyAuthz
        .mockResolvedValueOnce(semSimulacao) // stale 1
        .mockResolvedValueOnce(semSimulacao) // stale 2
        .mockResolvedValueOnce(comSimulacao); // confirma

      const promise = estado().startSimulation('g-recl', 'Reclutamiento - AG');
      await vi.advanceTimersByTimeAsync(1000); // stale 1 → intervalo
      await vi.advanceTimersByTimeAsync(1000); // stale 2 → intervalo
      await promise;

      expect(getMyAuthz).toHaveBeenCalledTimes(3);
      expect(estado().switching).toBeNull();
      expect(estado().switchError).toBeNull();
      expect(estado().authz?.simulation).toEqual(SIMULACAO);
    });

    it('(c) 5 tentativas todas stale — switchError="unconfirmed", switching volta a null', async () => {
      useAdminAuthStore.setState({ authz: semSimulacao, authzStatus: 'ready' });
      startSimulationApi.mockResolvedValue(SIMULACAO);
      getMyAuthz.mockResolvedValue(semSimulacao); // nunca reflete a troca

      const promise = estado().startSimulation('g-recl', 'Reclutamiento - AG');
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);
      await promise;

      expect(getMyAuthz).toHaveBeenCalledTimes(5);
      expect(estado().switching).toBeNull();
      expect(estado().switchError).toBe('unconfirmed');
    });

    it('(e) erro do POST: switching volta a null e a promessa REJEITA, sem tentar confirmar', async () => {
      useAdminAuthStore.setState({ authz: semSimulacao, authzStatus: 'ready' });
      const erro = Object.assign(new Error('422'), { code: 'group_not_simulable' });
      startSimulationApi.mockRejectedValue(erro);

      await expect(estado().startSimulation('g-x', 'Grupo X')).rejects.toThrow('422');

      expect(getMyAuthz).not.toHaveBeenCalled();
      expect(estado().switching).toBeNull();
      expect(estado().switchError).toBeNull();
    });
  });

  describe('endSimulation()', () => {
    it('confirma no 1º fetchAuthz (simulation: null) — switching volta a null sem erro', async () => {
      useAdminAuthStore.setState({ authz: comSimulacao, authzStatus: 'ready' });
      endSimulationApi.mockResolvedValue(undefined);
      getMyAuthz.mockResolvedValue(semSimulacao);

      const promise = estado().endSimulation();
      expect(estado().switching).toEqual({ kind: 'end' });

      await promise;

      expect(getMyAuthz).toHaveBeenCalledTimes(1);
      expect(estado().switching).toBeNull();
      expect(estado().switchError).toBeNull();
    });

    it('(d) L37 — ao final, simulationExpired é false mesmo que o fetchAuthz intermediário tenha marcado true', async () => {
      useAdminAuthStore.setState({ authz: comSimulacao, authzStatus: 'ready', simulationExpired: false } as never);
      endSimulationApi.mockResolvedValue(undefined);
      getMyAuthz.mockResolvedValue(semSimulacao);

      await estado().endSimulation();

      // o fetchAuthz interno do loop VÊ "tinha simulação → não tem mais" e liga a flag —
      // mas o `set` final de endSimulation zera de novo. Nenhum "expiró" sobrevive à troca explícita.
      expect(estado().simulationExpired).toBe(false);
      expect(estado().switching).toBeNull();
    });

    it('(e) erro do DELETE: switching volta a null e a promessa REJEITA, sem tentar confirmar', async () => {
      useAdminAuthStore.setState({ authz: comSimulacao, authzStatus: 'ready' });
      endSimulationApi.mockRejectedValue(new Error('network'));

      await expect(estado().endSimulation()).rejects.toThrow('network');

      expect(getMyAuthz).not.toHaveBeenCalled();
      expect(estado().switching).toBeNull();
    });
  });

  describe('dismissSwitchError()', () => {
    it('zera switchError sem mexer em mais nada', () => {
      useAdminAuthStore.setState({ switchError: 'unconfirmed' } as never);

      (estado() as unknown as { dismissSwitchError: () => void }).dismissSwitchError();

      expect(estado().switchError).toBeNull();
    });
  });
});
