/**
 * acesso-do-cliente F3 (T321) — controle: o selo de bloqueio por padrão NÃO pode negar rota `public`.
 *
 * Lê o inventário da app REAL (contêiner da API) e, SEM token, bate em toda rota de classe `public`: o status tem de
 * ser ∉ {401, 403}. Rota que exige corpo responde 400 ao `{}` (válido aqui). Corpo vazio de propósito: nenhuma rota
 * chega ao efeito de canal (lead, agendamento, desfazer vínculo, OAuth — todas validam antes de agir).
 *
 * Side-effect de cada rota `public` (mapeado em 09/11 lendo o handler): ver PUBLIC_NOTES. Puladas (nomeadas) em SKIP.
 * Controle do controle: uma rota `staff` do mesmo inventário, sem token, TEM de dar 401/403 — senão o teste não mede nada.
 */
import axios from 'axios';

const API_URL = process.env.API_URL || 'http://localhost:8080';
const INTERNAL_SECRET = process.env.INTERNAL_TOKEN_SECRET || 'test-secret-for-e2e-only';

interface InventoryRoute { method: string; path: string; class: string | null }

/**
 * Rotas `public` que NÃO entram na asserção ∉{401,403}, com o motivo. Ainda checadas: o selo não pode tê-las negado
 * (status !== 403 e sem `code: unclassified_route`).
 *
 * ACHADO DA T321 (LISTA): na stack de teste (USE_MOCK_AUTH=true) o `mockAuthMiddleware` global (`index.ts:223`) devolve 401
 * "Authorization header required" ANTES da rota para tudo que não está no `publicPaths` fixo de `MockAuthMiddleware.ts:30`.
 * Três rotas `public` não estão lá. O 401 vem do dublê de auth (que em prd não roda), não do selo nem do código de prd.
 * Conserto = 3 entradas em `publicPaths` (arquivo fora do escopo desta task).
 */
const MOCK_PUBLICPATHS = 'o 401 vem do mockAuthMiddleware (publicPaths do dublê não lista esta rota; em prd o mock não roda), não do selo';
const SKIP: Record<string, string> = {
  'GET /api/test/auth/verify': 'handler próprio devolve 401 sem token mock (exige token por desenho; só existe com USE_MOCK_AUTH) — o 401 não vem do selo',
  'GET /api/account-link/undo/:token': MOCK_PUBLICPATHS,
  'POST /api/account-link/undo/:token': MOCK_PUBLICPATHS,
  'POST /api/admin/auth/telemetry': MOCK_PUBLICPATHS,
};

const concretePath = (p: string) => p.replace(/:[A-Za-z0-9_]+/g, 'x');

/** Código/erro curto da resposta (nunca o corpo inteiro). */
const motivo = (d: unknown): string =>
  typeof d === 'string' ? d.slice(0, 60) : `${(d as { code?: string })?.code ?? ''} ${(d as { error?: string })?.error ?? ''}`.trim();

async function hit(method: string, path: string) {
  return axios.request({
    method: method as 'GET' | 'POST',
    url: `${API_URL}${concretePath(path)}`,
    data: method === 'GET' ? undefined : {},
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
    validateStatus: () => true,
    maxRedirects: 0,
    timeout: 20000,
  });
}

describe('F3 — rotas public sem token não são bloqueadas (T321)', () => {
  let routes: InventoryRoute[];
  beforeAll(async () => {
    const res = await axios.get(`${API_URL}/.well-known/permissions/routes`, {
      headers: { 'X-Internal-Secret': INTERNAL_SECRET },
      validateStatus: () => true,
    });
    expect(res.status).toBe(200);
    routes = res.data.routes as InventoryRoute[];
  });

  it('toda rota public sem token → status ∉ {401, 403}; contagem percorrida > 0', async () => {
    const publicas = routes.filter((r) => r.class === 'public' && r.method !== 'USE');
    const pulados = publicas.filter((r) => SKIP[`${r.method} ${r.path}`]);
    const alvo = publicas.filter((r) => !SKIP[`${r.method} ${r.path}`]);
    const bloqueadas: string[] = [];
    const linhas: string[] = [];
    for (const r of alvo) {
      const res = await hit(r.method, r.path);
      linhas.push(`${r.method} ${r.path} -> ${res.status}`);
      if (res.status === 401 || res.status === 403) bloqueadas.push(`${r.method} ${r.path} -> ${res.status} ${motivo(res.data)}`);
    }
    for (const r of pulados) {
      const res = await hit(r.method, r.path);
      linhas.push(`[pulada: ${SKIP[`${r.method} ${r.path}`]}] ${r.method} ${r.path} -> ${res.status}`);
      expect(res.data?.code).not.toBe('unclassified_route'); // o selo não pode ter sido quem negou
      expect(res.status).not.toBe(403);
    }
    // eslint-disable-next-line no-console
    console.log(`[T321] public no inventario=${publicas.length} percorridas=${alvo.length} puladas=${pulados.length}\n${linhas.join('\n')}`);
    expect(alvo.length).toBeGreaterThan(0);
    expect(alvo.length + pulados.length).toBe(publicas.length);
    expect(bloqueadas).toEqual([]);
  });

  it('controle do controle: rota staff sem token → 401/403 (o teste distingue bloqueio de passagem)', async () => {
    const staff = routes.find((r) => r.class === 'staff' && r.method === 'GET' && r.path.startsWith('/api/admin/') && !r.path.includes(':'));
    expect(staff).toBeDefined();
    const res = await hit(staff!.method, staff!.path);
    expect([401, 403]).toContain(res.status);
  });
});
