/**
 * acesso-do-cliente F3 (T317) — conta SÓ-ALUNO fora de toda rota que não é pública.
 *
 * App REAL de pé (contêiner `api`, `index.ts` inteiro, Cedar do cliente + guards reais). A conta tem UM vínculo
 * (`iam.grant_area_membership(pid, 'learn', 'learner')`), sem ficha de prestador (`workers`) e sem staff (`users`).
 * Percorre `GET /.well-known/permissions/routes` (runtime) e bate em TODA rota com classe ≠ `public` com o token dela:
 * status ∈ {401, 403} em 100%, exceto as rotas de `REACHES` (nomeadas, com motivo) — esse conjunto é o que o teste
 * CAÇA: rota nova que o aluno alcance faz o teste ficar vermelho; rota de `REACHES` que passe a negar também (a lista
 * envelhece e o teste avisa).
 *
 * Side-effect de cada rota `service`/`client-policy`: `evidencias/f3-side-effects.md` (mapeado ANTES deste teste).
 * Corpo `{}` em toda chamada com corpo: nenhuma rota que não negue chega a efeito além de validação. Sem PII.
 *
 * Controles (sem eles um token inválido faria o teste passar por 401 em tudo):
 *   · o MESMO token autentica (`GET /v1/me/areas` → 200 com `learn`·`learner`);
 *   · numa rota staff o aluno leva 403 (principal resolvido, guard negou), não 401;
 *   · contagem percorrida > 0 e soma(percorridas + puladas) = total ≠ public.
 */
import { randomBytes } from 'crypto';
import axios from 'axios';
import { Pool } from 'pg';

const API_URL = process.env.API_URL || 'http://localhost:8080';
const INTERNAL_SECRET = process.env.INTERNAL_TOKEN_SECRET || 'test-secret-for-e2e-only';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = randomBytes(4).toString('hex');
const UID = `e2e-learner-only-${RUN}`;
const SYNTHETIC_ID = '00000000-0000-4000-8000-000000000317';

interface InventoryRoute { method: string; path: string; class: string | null }

/**
 * Rotas ≠ public que o aluno ALCANÇA (status fora de {401,403}) por desenho atual — achado da T317, não decisão.
 * Chave `MÉTODO caminho` → motivo (guard exato). Cada uma entra na LISTA da Evidência com severidade.
 */
const REACHES: Record<string, string> = {
  'POST /api/workers/init': 'requireAuth sem Cedar (index.ts:340, D650/H2): qualquer conta autenticada cria a PRÓPRIA ficha de prestador (1º cadastro) — é o portão de entrada do prestador',
  'POST /api/auth/claim/start': 'requireAuth sem Cedar (claimRoutes.ts:57): só usa uid/e-mail do próprio token (H3, D650); 400 = corpo vazio',
  'POST /api/auth/claim/confirm': 'requireAuth sem Cedar (claimRoutes.ts:65): idem; 400 = corpo vazio',
  'DELETE /api/users/me': 'user:delete é Cedar (DeleteOwnAccount, policies/account.ts:5): qualquer Person apaga o PRÓPRIO login (resource.uid == token); 400 = sem credencial Identity no stack',
  'GET /v1/me/areas': 'requireAuth por desenho (F1): é como o aluno descobre as próprias áreas — devolve só as dele',
  'GET /api/admin/auth/profile': 'requireAuth sem requireStaff (index.ts:606, "auto-provisioning no 1º login Google"): 404 para o aluno (sem users)',
  'POST /api/webhooks/talentum/prescreening': 'PartnerAuthMiddleware pula a chave com USE_MOCK_AUTH=true (só stack de teste; em prd 401 sem X-Partner-Key); 400 = corpo vazio',
  'POST /api/webhooks-test/talentum/prescreening': 'idem (mesmo router montado em /api/webhooks-test)',
  'GET /api/docs/openapi.json': 'swaggerRouter sem guard fora de NODE_ENV=production (shouldGateDocs); classe staff só vale gateado',
  'GET /api/docs/_routes': 'idem — enumera as rotas registradas',
  'GET /api/docs': 'idem — UI do Swagger (301 → /api/docs/)',
};

/** Rotas que o teste não percorre, com o motivo. */
const SKIP: Record<string, string> = {};

const concretePath = (p: string) => p.replace(/\\\./g, '.').replace(/:[A-Za-z0-9_]+/g, SYNTHETIC_ID);

const bearer = (uid: string, role: string) =>
  `Bearer mock_${Buffer.from(JSON.stringify({ uid, email: `${uid}@e2e.local`, role, country: 'AR' })).toString('base64')}`;

describe('F3 — só-aluno fora de tudo (T317)', () => {
  let pool: Pool;
  let routes: InventoryRoute[];
  const auth = bearer(UID, 'worker');

  async function hit(method: string, path: string, headers: Record<string, string> = { Authorization: auth }) {
    return axios.request({
      method: method as 'GET',
      url: `${API_URL}${concretePath(path)}`,
      data: method === 'GET' || method === 'DELETE' ? undefined : {},
      headers: { ...headers, ...(method === 'GET' || method === 'DELETE' ? {} : { 'Content-Type': 'application/json' }) },
      validateStatus: () => true,
      maxRedirects: 0,
      timeout: 30000,
    });
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    const pid = (await pool.query(`SELECT iam.ensure_person('firebase', $1) AS p`, [UID])).rows[0].p;
    await pool.query(`SELECT iam.grant_area_membership($1::uuid, 'learn', 'learner', $2)`, [pid, `${UID}-ator`]);
    const inv = await axios.get(`${API_URL}/.well-known/permissions/routes`, {
      headers: { 'X-Internal-Secret': INTERNAL_SECRET },
      validateStatus: () => true,
    });
    expect(inv.status).toBe(200);
    routes = (inv.data.routes as InventoryRoute[]).filter((r) => r.method !== 'USE');
  }, 60000);

  afterAll(async () => {
    await pool?.end();
  });

  it('controle 1: o token do aluno autentica — GET /v1/me/areas → 200 com learn·learner (não é 401 por token ruim)', async () => {
    const res = await hit('GET', '/v1/me/areas');
    expect(res.status).toBe(200);
    expect(res.data.areas).toEqual([{ area: 'learn', role: 'learner', entryRoute: null }]);
  });

  it('controle 2: numa rota staff o aluno leva 403 (principal resolvido, guard negou) — não 401', async () => {
    const staff = routes.find((r) => r.class === 'staff' && r.method === 'GET' && r.path.startsWith('/api/admin/') && !r.path.includes(':'));
    expect(staff).toBeDefined();
    const res = await hit(staff!.method, staff!.path);
    expect(res.status).toBe(403);
  });

  it('toda rota com classe ≠ public → 401/403 (menos REACHES nomeadas); contagem percorrida > 0', async () => {
    const naoPublicas = routes.filter((r) => r.class !== 'public');
    // POST /api/workers/init CRIA a ficha da conta: roda por último, senão as rotas /me seguintes medem "aluno COM ficha".
    const ultimo = (r: InventoryRoute) => (r.method === 'POST' && r.path === '/api/workers/init' ? 1 : 0);
    const alvo = naoPublicas.filter((r) => !SKIP[`${r.method} ${r.path}`]).sort((a, b) => ultimo(a) - ultimo(b));
    const porStatus: Record<string, number> = {};
    const porClasse: Record<string, { total: number; negadas: number }> = {};
    const alcancou: string[] = [];
    for (const r of alvo) {
      const res = await hit(r.method, r.path);
      porStatus[res.status] = (porStatus[res.status] ?? 0) + 1;
      const c = (porClasse[r.class ?? 'NULL'] ??= { total: 0, negadas: 0 });
      c.total += 1;
      if (res.status === 401 || res.status === 403) c.negadas += 1;
      else alcancou.push(`${r.method} ${r.path} [${r.class}] -> ${res.status}`);
    }
    // eslint-disable-next-line no-console
    console.log(
      `[T317] inventario=${routes.length} public=${routes.length - naoPublicas.length} nao_public=${naoPublicas.length} ` +
        `puladas=${naoPublicas.length - alvo.length} percorridas=${alvo.length} porStatus=${JSON.stringify(porStatus)} ` +
        `porClasse=${JSON.stringify(porClasse)} negadas401_403=${alvo.length - alcancou.length}/${alvo.length}\n` +
        `alcancadas(${alcancou.length}):\n${alcancou.join('\n')}`,
    );
    expect(alvo.length).toBeGreaterThan(0);
    expect(alvo.length + Object.keys(SKIP).length).toBe(naoPublicas.length);
    const inesperadas = alcancou.filter((l) => !REACHES[l.split(' [')[0]]);
    expect(inesperadas).toEqual([]);
    // a lista de REACHES não pode envelhecer em silêncio: rota nomeada que passou a negar sai da lista
    const envelheceu = Object.keys(REACHES).filter((k) => !alcancou.some((l) => l.startsWith(`${k} [`)));
    expect(envelheceu).toEqual([]);
  }, 600000);

  it('o aluno não ganhou conta de staff e no máximo a ficha de POST /api/workers/init (sem outra escrita colateral)', async () => {
    const w = await pool.query(`SELECT count(*)::int AS n FROM workers WHERE auth_uid = $1`, [UID]);
    const u = await pool.query(`SELECT count(*)::int AS n FROM users WHERE firebase_uid = $1`, [UID]);
    // eslint-disable-next-line no-console
    console.log(`[T317] apos percorrer: workers=${w.rows[0].n} users=${u.rows[0].n}`);
    // única escrita admitida: a ficha criada por POST /api/workers/init (REACHES); nunca conta de staff
    expect(u.rows[0].n).toBe(0);
    expect(w.rows[0].n).toBeLessThanOrEqual(1);
  });
});
