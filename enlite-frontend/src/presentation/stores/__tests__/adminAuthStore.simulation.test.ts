import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * F3/T3.1 (spec 026) — RED da store para simulação de grupo de acesso.
 * Molde: adminAuthStore.authz.test.ts (mesmo padrão de mock de
 * FirebaseAuthService/AdminApiService/AdminAuthzApiService).
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
const listSimulatableGroupsApi = vi.fn();
vi.mock('@infrastructure/http/AdminAuthzApiService', () => ({
  AdminAuthzApiService: {
    getMyAuthz: (...a: unknown[]) => getMyAuthz(...a),
    startSimulation: (...a: unknown[]) => startSimulationApi(...a),
    endSimulation: (...a: unknown[]) => endSimulationApi(...a),
    listSimulatableGroups: (...a: unknown[]) => listSimulatableGroupsApi(...a),
  },
}));

import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

type StoreComSimulacao = ReturnType<typeof useAdminAuthStore.getState> & {
  simulationExpired: boolean;
  startSimulation: (groupId: string) => Promise<void>;
  endSimulation: () => Promise<void>;
  dismissSimulationExpired: () => void;
  listSimulatableGroups: () => Promise<Array<{ id: string; name: string }>>;
};

const estado = (): StoreComSimulacao => useAdminAuthStore.getState() as unknown as StoreComSimulacao;

const SIMULACAO = {
  id: 's1',
  groupId: 'g-recl',
  groupName: 'Reclutamiento - AG',
  startedAt: '2026-09-23T10:00:00.000Z',
  expiresAt: '2026-09-23T14:00:00.000Z',
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

describe('adminAuthStore — simulação de grupo de acesso (F3/T3.1, decisões #2/#4)', () => {
  beforeEach(() => {
    getMyAuthz.mockReset();
    startSimulationApi.mockReset();
    endSimulationApi.mockReset();
    listSimulatableGroupsApi.mockReset();
    useAdminAuthStore.setState({
      user: null,
      adminProfile: null,
      isAuthenticated: false,
      authz: null,
      authzStatus: 'idle',
      simulationExpired: false,
    } as never);
  });

  describe('startSimulation(groupId)', () => {
    it('chama a API de start com o groupId e depois refaz fetchAuthz — authz final espelha o novo contrato', async () => {
      useAdminAuthStore.setState({ authz: semSimulacao, authzStatus: 'ready' });
      startSimulationApi.mockResolvedValue(SIMULACAO);
      getMyAuthz.mockResolvedValue(comSimulacao);

      await estado().startSimulation('g-recl');

      expect(startSimulationApi).toHaveBeenCalledWith('g-recl');
      expect(getMyAuthz).toHaveBeenCalledTimes(1);
      expect(estado().authz?.simulation).toEqual(SIMULACAO);
      expect(estado().authzStatus).toBe('ready');
    });

    it('chama start ANTES de getMyAuthz — o refetch tem que ver o efeito do start, não o estado velho', async () => {
      const ordem: string[] = [];
      startSimulationApi.mockImplementation(async () => {
        ordem.push('start');
        return SIMULACAO;
      });
      getMyAuthz.mockImplementation(async () => {
        ordem.push('fetch');
        return comSimulacao;
      });
      useAdminAuthStore.setState({ authz: semSimulacao, authzStatus: 'ready' });

      await estado().startSimulation('g-recl');

      expect(ordem).toEqual(['start', 'fetch']);
    });

    it('🔴 em erro do POST (ex.: 422 group_not_simulable): authz anterior fica intacto, authzStatus continua "ready", e a ação REJEITA', async () => {
      useAdminAuthStore.setState({ authz: semSimulacao, authzStatus: 'ready' });
      const erro = Object.assign(new Error('422'), { code: 'group_not_simulable' });
      startSimulationApi.mockRejectedValue(erro);

      await expect(estado().startSimulation('g-x')).rejects.toThrow('422');

      expect(getMyAuthz).not.toHaveBeenCalled();
      expect(estado().authz).toEqual(semSimulacao);
      expect(estado().authzStatus).toBe('ready');
    });

    it('zera simulationExpired mesmo que estivesse true antes de chamar', async () => {
      useAdminAuthStore.setState({ authz: semSimulacao, authzStatus: 'ready', simulationExpired: true } as never);
      startSimulationApi.mockResolvedValue(SIMULACAO);
      getMyAuthz.mockResolvedValue(comSimulacao);

      await estado().startSimulation('g-recl');

      expect(estado().simulationExpired).toBe(false);
    });
  });

  describe('endSimulation()', () => {
    it('chama a API de end (sem argumento) e depois refaz fetchAuthz', async () => {
      useAdminAuthStore.setState({ authz: comSimulacao, authzStatus: 'ready' });
      endSimulationApi.mockResolvedValue(undefined);
      getMyAuthz.mockResolvedValue(semSimulacao);

      await estado().endSimulation();

      expect(endSimulationApi).toHaveBeenCalledTimes(1);
      expect(getMyAuthz).toHaveBeenCalledTimes(1);
      expect(estado().authz?.simulation).toBeNull();
    });

    it('o fetch decorrente do próprio endSimulation NÃO marca simulationExpired — foi ação do ator, não vencimento de TTL', async () => {
      useAdminAuthStore.setState({ authz: comSimulacao, authzStatus: 'ready', simulationExpired: false } as never);
      endSimulationApi.mockResolvedValue(undefined);
      getMyAuthz.mockResolvedValue(semSimulacao);

      await estado().endSimulation();

      expect(estado().simulationExpired).toBe(false);
    });

    it('zera simulationExpired mesmo que estivesse true antes de chamar', async () => {
      useAdminAuthStore.setState({ authz: comSimulacao, authzStatus: 'ready', simulationExpired: true } as never);
      endSimulationApi.mockResolvedValue(undefined);
      getMyAuthz.mockResolvedValue(semSimulacao);

      await estado().endSimulation();

      expect(estado().simulationExpired).toBe(false);
    });
  });

  describe('"expiró" — TTL de 4h vencido sem endSimulation explícito (decisão #4)', () => {
    it('🔴 fetchAuthz() genérico (ex.: troca de área) que devolve simulation:null quando o contrato ANTERIOR tinha simulation: marca simulationExpired=true', async () => {
      useAdminAuthStore.setState({ authz: comSimulacao, authzStatus: 'ready', simulationExpired: false } as never);
      getMyAuthz.mockResolvedValue(semSimulacao);

      await estado().fetchAuthz();

      expect(estado().simulationExpired).toBe(true);
      expect(estado().authz?.simulation).toBeNull();
    });

    it('fetchAuthz() que devolve simulation AINDA presente: (re)põe simulationExpired em false', async () => {
      // seed PROPOSITALMENTE errado (`true`, como se tivesse sobrado de um aviso
      // anterior) — sem implementação, nada zera a flag, e o teste falha de
      // verdade em vez de passar à toa contra o default `false`.
      useAdminAuthStore.setState({ authz: comSimulacao, authzStatus: 'ready', simulationExpired: true } as never);
      getMyAuthz.mockResolvedValue(comSimulacao);

      await estado().fetchAuthz();

      expect(estado().simulationExpired).toBe(false);
    });

    it('fetchAuthz() sem simulação nem antes nem depois: (re)põe simulationExpired em false — nada estava vencendo', async () => {
      // mesmo motivo do teste acima: seed propositalmente `true`.
      useAdminAuthStore.setState({ authz: semSimulacao, authzStatus: 'ready', simulationExpired: true } as never);
      getMyAuthz.mockResolvedValue(semSimulacao);

      await estado().fetchAuthz();

      expect(estado().simulationExpired).toBe(false);
    });

    it('dismissSimulationExpired() zera a flag', () => {
      useAdminAuthStore.setState({ simulationExpired: true } as never);

      estado().dismissSimulationExpired();

      expect(estado().simulationExpired).toBe(false);
    });
  });

  describe('listSimulatableGroups()', () => {
    it('devolve [{id,name}] vindo da API, sem transformação', async () => {
      const grupos = [
        { id: 'g-recl', name: 'Reclutamiento - AG' },
        { id: 'g-fin', name: 'Finanzas - AG' },
      ];
      listSimulatableGroupsApi.mockResolvedValue(grupos);

      const resultado = await estado().listSimulatableGroups();

      expect(listSimulatableGroupsApi).toHaveBeenCalledTimes(1);
      expect(resultado).toEqual(grupos);
    });
  });
});
