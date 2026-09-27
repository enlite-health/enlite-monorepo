/**
 * TalentumApiClient.test.ts
 *
 * Testa os metodos de paginacao adicionados no Step 1 do sync:
 *  - listPrescreenings(opts) — envia query params corretos
 *  - listAllPrescreenings() — itera todas as paginas
 *
 * Auth (login/encryptPassword) e testado indiretamente via mock do fetch.
 * Os metodos createPrescreening/getPrescreening/deletePrescreening ja existiam.
 */

// ── Mock do fetch global ─────────────────────────────────────────

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

import { TalentumApiClient } from '../TalentumApiClient';
import type { TalentumProject } from '../../domain/ITalentumApiClient';

// ── Helpers ──────────────────────────────────────────────────────

function makeLoginResponse() {
  return {
    ok: true,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(''),
    headers: {
      getSetCookie: () => [
        'tl_auth=mock-auth-token; Path=/; HttpOnly',
        'tl_refresh=mock-refresh-token; Path=/; HttpOnly',
      ],
    },
  };
}

function makeListResponse(projects: Partial<TalentumProject>[], count: number) {
  return {
    ok: true,
    json: () => Promise.resolve({ projects, count }),
    text: () => Promise.resolve(''),
  };
}

function makeProject(overrides: Partial<TalentumProject> = {}): Partial<TalentumProject> {
  return {
    projectId: overrides.projectId ?? 'proj-1',
    publicId: overrides.publicId ?? 'pub-1',
    title: overrides.title ?? 'CASO 1',
    description: overrides.description ?? 'desc',
    whatsappUrl: overrides.whatsappUrl ?? 'https://wa.me/1',
    slug: overrides.slug ?? 'caso-1',
    active: overrides.active ?? true,
    timestamp: overrides.timestamp ?? '2025-01-01T00:00:00Z',
    questions: overrides.questions ?? [],
    faq: overrides.faq ?? [],
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('TalentumApiClient — paginacao', () => {
  let client: TalentumApiClient;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation();
    client = new TalentumApiClient('test@talentum.chat', 'test-password');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── listPrescreenings ────────────────────────────────────────

  describe('listPrescreenings', () => {
    it('deve enviar page como query param', async () => {
      // Login
      mockFetch.mockResolvedValueOnce(makeLoginResponse());
      // List
      mockFetch.mockResolvedValueOnce(makeListResponse([makeProject()], 1));

      await client.listPrescreenings({ page: 3 });

      const listCall = mockFetch.mock.calls[1];
      const url = listCall[0] as string;
      expect(url).toContain('page=3');
    });

    it('deve enviar onlyOwnedByUser como query param', async () => {
      mockFetch.mockResolvedValueOnce(makeLoginResponse());
      mockFetch.mockResolvedValueOnce(makeListResponse([], 0));

      await client.listPrescreenings({ onlyOwnedByUser: false });

      const url = mockFetch.mock.calls[1][0] as string;
      expect(url).toContain('onlyOwnedByUser=false');
    });

    it('deve enviar ambos params quando fornecidos', async () => {
      mockFetch.mockResolvedValueOnce(makeLoginResponse());
      mockFetch.mockResolvedValueOnce(makeListResponse([], 0));

      await client.listPrescreenings({ page: 2, onlyOwnedByUser: true });

      const url = mockFetch.mock.calls[1][0] as string;
      expect(url).toContain('page=2');
      expect(url).toContain('onlyOwnedByUser=true');
    });

    it('deve enviar sem query params quando opts vazio', async () => {
      mockFetch.mockResolvedValueOnce(makeLoginResponse());
      mockFetch.mockResolvedValueOnce(makeListResponse([], 0));

      await client.listPrescreenings();

      const url = mockFetch.mock.calls[1][0] as string;
      expect(url).toMatch(/\/pre-screening\/projects$/);
    });

    it('deve retornar projects e count', async () => {
      const proj = makeProject({ projectId: 'p-abc' });
      mockFetch.mockResolvedValueOnce(makeLoginResponse());
      mockFetch.mockResolvedValueOnce(makeListResponse([proj], 5));

      const result = await client.listPrescreenings({ page: 1 });

      expect(result.projects).toHaveLength(1);
      expect(result.projects[0].projectId).toBe('p-abc');
      expect(result.count).toBe(5);
    });
  });

  // ── listAllPrescreenings ─────────────────────────────────────

  describe('listAllPrescreenings', () => {
    it('deve iterar todas as paginas ate receber array vazio', async () => {
      // Login (chamado 1x, auth reutilizado)
      mockFetch.mockResolvedValueOnce(makeLoginResponse());

      // Pagina 1: 2 projects
      mockFetch.mockResolvedValueOnce(
        makeListResponse([makeProject({ projectId: 'p1' }), makeProject({ projectId: 'p2' })], 3),
      );
      // Pagina 2: 1 project
      mockFetch.mockResolvedValueOnce(
        makeListResponse([makeProject({ projectId: 'p3' })], 3),
      );
      // Pagina 3: vazio (stop)
      mockFetch.mockResolvedValueOnce(makeListResponse([], 3));

      const all = await client.listAllPrescreenings();

      expect(all).toHaveLength(3);
      expect(all.map(p => p.projectId)).toEqual(['p1', 'p2', 'p3']);
    });

    it('deve retornar array vazio quando primeira pagina e vazia', async () => {
      mockFetch.mockResolvedValueOnce(makeLoginResponse());
      mockFetch.mockResolvedValueOnce(makeListResponse([], 0));

      const all = await client.listAllPrescreenings();

      expect(all).toEqual([]);
    });

    it('deve passar onlyOwnedByUser=false em todas as chamadas', async () => {
      mockFetch.mockResolvedValueOnce(makeLoginResponse());
      mockFetch.mockResolvedValueOnce(
        makeListResponse([makeProject()], 1),
      );
      mockFetch.mockResolvedValueOnce(makeListResponse([], 1));

      await client.listAllPrescreenings();

      // Calls: [0]=login, [1]=page1, [2]=page2
      const page1Url = mockFetch.mock.calls[1][0] as string;
      const page2Url = mockFetch.mock.calls[2][0] as string;
      expect(page1Url).toContain('onlyOwnedByUser=false');
      expect(page2Url).toContain('onlyOwnedByUser=false');
    });

    it('deve incrementar page a cada chamada', async () => {
      mockFetch.mockResolvedValueOnce(makeLoginResponse());
      mockFetch.mockResolvedValueOnce(makeListResponse([makeProject()], 2));
      mockFetch.mockResolvedValueOnce(makeListResponse([makeProject()], 2));
      mockFetch.mockResolvedValueOnce(makeListResponse([], 2));

      await client.listAllPrescreenings();

      const page1Url = mockFetch.mock.calls[1][0] as string;
      const page2Url = mockFetch.mock.calls[2][0] as string;
      const page3Url = mockFetch.mock.calls[3][0] as string;
      expect(page1Url).toContain('page=1');
      expect(page2Url).toContain('page=2');
      expect(page3Url).toContain('page=3');
    });
  });

  // ── Static factories ─────────────────────────────────────────

  describe('static factories', () => {
    it('fromEnv deve lançar se env vars ausentes', () => {
      delete process.env.TALENTUM_API_EMAIL;
      delete process.env.TALENTUM_API_PASSWORD;

      expect(() => TalentumApiClient.fromEnv()).toThrow(
        'TALENTUM_API_EMAIL and TALENTUM_API_PASSWORD must be set',
      );
    });

    it('fromEnv deve criar instancia com env vars', () => {
      process.env.TALENTUM_API_EMAIL = 'e@test.com';
      process.env.TALENTUM_API_PASSWORD = 'p123';

      const instance = TalentumApiClient.fromEnv();
      expect(instance).toBeInstanceOf(TalentumApiClient);

      delete process.env.TALENTUM_API_EMAIL;
      delete process.env.TALENTUM_API_PASSWORD;
    });

    it('create deve usar fromEnv quando env vars presentes', async () => {
      process.env.TALENTUM_API_EMAIL = 'e@test.com';
      process.env.TALENTUM_API_PASSWORD = 'p123';

      const instance = await TalentumApiClient.create();
      expect(instance).toBeInstanceOf(TalentumApiClient);

      delete process.env.TALENTUM_API_EMAIL;
      delete process.env.TALENTUM_API_PASSWORD;
    });
  });

  // ── Auth / login ─────────────────────────────────────────────

  describe('auth', () => {
    it('deve fazer login antes da primeira request', async () => {
      mockFetch.mockResolvedValueOnce(makeLoginResponse());
      mockFetch.mockResolvedValueOnce(makeListResponse([], 0));

      await client.listPrescreenings();

      // Primeira chamada = login
      const loginCall = mockFetch.mock.calls[0];
      const loginUrl = loginCall[0] as string;
      expect(loginUrl).toContain('/auth/login');
    });

    it('deve lançar erro se login falha', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Unauthorized'),
      });

      await expect(client.listPrescreenings()).rejects.toThrow('login failed');
    });

    it('deve lançar erro se cookies ausentes no login', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(''),
        headers: {
          getSetCookie: () => [],
        },
      });

      await expect(client.listPrescreenings()).rejects.toThrow('tl_auth/tl_refresh cookies were not found');
    });

    it('deve propagar erro HTTP em requests', async () => {
      mockFetch.mockResolvedValueOnce(makeLoginResponse());
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      });

      await expect(client.listPrescreenings()).rejects.toThrow('HTTP 500');
    });
  });

  // ── Base URL por env (DX-6.8 / P2) ────────────────────────────

  describe('talentumBaseUrl', () => {
    const ENV_KEY = 'TALENTUM_API_BASE_URL';
    const originalEnv = process.env[ENV_KEY];

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env[ENV_KEY];
      } else {
        process.env[ENV_KEY] = originalEnv;
      }
    });

    it('sem a env, a 1a URL do fetch (login) usa o host de producao', async () => {
      delete process.env[ENV_KEY];
      mockFetch.mockResolvedValueOnce(makeLoginResponse());
      mockFetch.mockResolvedValueOnce(makeListResponse([], 0));

      await client.listPrescreenings();

      const loginUrl = mockFetch.mock.calls[0][0] as string;
      expect(loginUrl).toBe('https://api.production.talentum.chat/auth/login');
    });

    it('com a env setada, login e request vao ao host do stub', async () => {
      process.env[ENV_KEY] = 'http://stub.local:9914';
      mockFetch.mockResolvedValueOnce(makeLoginResponse());
      mockFetch.mockResolvedValueOnce(makeListResponse([], 0));

      await client.createPrescreening({
        title: 't',
        description: 'd',
      } as never);

      const loginUrl = mockFetch.mock.calls[0][0] as string;
      const requestUrl = mockFetch.mock.calls[1][0] as string;
      expect(loginUrl).toBe('http://stub.local:9914/auth/login');
      expect(requestUrl).toBe('http://stub.local:9914/pre-screening/projects');
    });

    it('env vazia ou só com espaços cai no default', async () => {
      process.env[ENV_KEY] = '   ';
      mockFetch.mockResolvedValueOnce(makeLoginResponse());
      mockFetch.mockResolvedValueOnce(makeListResponse([], 0));

      await client.listPrescreenings();

      const loginUrl = mockFetch.mock.calls[0][0] as string;
      expect(loginUrl).toBe('https://api.production.talentum.chat/auth/login');
    });
  });
});
