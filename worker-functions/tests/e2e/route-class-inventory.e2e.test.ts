/**
 * acesso-do-cliente F3 (T315) — nenhuma rota do app REAL sem classe de acesso.
 *
 * O unit `routeClassCoverage.test.ts` varre routers reais com controllers-dublê, mas `index.ts` não é importável
 * (efeito colateral na carga): as rotas INLINE de `index.ts`/`startServer.ts` só se provam com a app de pé. Este e2e lê
 * `GET /.well-known/permissions/routes` do contêiner da API (a app inteira, `node dist/index.js`) e exige:
 *   · 0 rotas com `class == null` e `unclassified[]` vazio;
 *   · contagem percorrida > 0 (zero é falha, não sucesso);
 *   · controle positivo: rotas inline conhecidas aparecem com a classe esperada (prova que a varredura enxerga `index.ts`).
 *
 * Total de rotas: logado ao lado do total da F0 (b) (445 registradas). A diferença é listada na Evidência da task.
 * Se INVENTORY_DUMP=<arquivo> estiver setado, grava o inventário (método, caminho, classe — sem dado de pessoa) para o diff.
 */
import axios from 'axios';
import { writeFileSync } from 'fs';

const API_URL = process.env.API_URL || 'http://localhost:8080';
const INTERNAL_SECRET = process.env.INTERNAL_TOKEN_SECRET || 'test-secret-for-e2e-only';
const CLASSES = ['public', 'service', 'client-policy', 'staff'];
/** F0 (b), fatos-medidos.md: 445 rotas registradas em runtime (base 80420ee69). */
const F0_TOTAL_REGISTERED = 445;

interface InventoryRoute { method: string; path: string; class: string | null }
interface Inventory { totalRoutes: number; routes: InventoryRoute[]; unclassified: string[] }

async function readInventory(): Promise<Inventory> {
  const res = await axios.get(`${API_URL}/.well-known/permissions/routes`, {
    headers: { 'X-Internal-Secret': INTERNAL_SECRET },
    validateStatus: () => true,
  });
  expect(res.status).toBe(200);
  return res.data as Inventory;
}

describe('F3 — inventário de rotas com a app de pé (T315)', () => {
  let inv: Inventory;
  beforeAll(async () => { inv = await readInventory(); });

  it('o inventário exige credencial (controle: sem segredo interno não lê)', async () => {
    const res = await axios.get(`${API_URL}/.well-known/permissions/routes`, { validateStatus: () => true });
    expect([401, 403]).toContain(res.status);
  });

  it('0 rotas com class == null (e unclassified[] vazio), com contagem percorrida > 0', () => {
    const semClasse = inv.routes.filter((r) => r.class == null);
    const porClasse: Record<string, number> = {};
    for (const r of inv.routes) porClasse[r.class ?? 'NULL'] = (porClasse[r.class ?? 'NULL'] ?? 0) + 1;
    // eslint-disable-next-line no-console
    console.log(
      `[T315] totalRoutes(registry)=${inv.totalRoutes} rotas(sem USE)=${inv.routes.length} sem_classe=${semClasse.length} ` +
        `porClasse=${JSON.stringify(porClasse)} | F0(b) registradas=${F0_TOTAL_REGISTERED} diferenca=${inv.totalRoutes - F0_TOTAL_REGISTERED}`,
    );
    if (process.env.INVENTORY_DUMP) {
      writeFileSync(process.env.INVENTORY_DUMP, inv.routes.map((r) => `${r.method}\t${r.path}\t${r.class ?? ''}`).join('\n') + '\n');
    }
    expect(inv.routes.length).toBeGreaterThan(0);
    expect(semClasse.map((r) => `${r.method} ${r.path}`)).toEqual([]);
    expect(inv.unclassified).toEqual([]);
    for (const r of inv.routes.filter((x) => x.class != null)) expect(CLASSES).toContain(r.class);
  });

  it('controle positivo: rotas inline de index.ts aparecem com a classe esperada', () => {
    const classOf = (m: string, p: string) => inv.routes.find((r) => r.method === m && r.path === p)?.class;
    expect(classOf('GET', '/health')).toBe('public');
    expect(classOf('GET', '/api/jobs')).toBe('public');
    expect(classOf('GET', '/api/public/v1/leads') ?? classOf('POST', '/api/public/v1/leads')).toBe('public');
    expect(classOf('POST', '/api/workers/init')).toBe('client-policy');
  });
});
