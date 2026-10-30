/**
 * pedidos-ia-078.e2e.test.ts — spec 078, M3b-1: a página de pedidos do Sol (backend) contra POSTGRES REAL e HTTP real, com o
 * ENGINE DE PERMISSÃO LIGADO (`admin.integrations`). Células `pedidos_ia:read` / `pedidos_ia:decidir` (migration 552).
 * Prova: read sem decidir -> GET 200 e POST 403; decidir -> 200 + exatamente 1 linha em `pedido_eventos` (humano, uid do staff,
 * presa à atitude de MAIOR versão); ver não deixa evento (item 51); 2ª decisão na mesma atitude -> 409; negar sem motivo -> 400;
 * sem credencial / conta não-staff -> 401/403; a view `pedido_status` troca novo -> aceito/negado/redirecionado.
 * Dados SINTÉTICOS (área única por rodada); a limpeza usa a conexão de admin (o app é INSERT-only).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';
import {
  TENANT_E2E,
  tokenMock,
  montarAppDeFamilia,
  limparIamFixtures,
  grupoComCelulas,
  type AppDeFamilia,
} from './helpers/permissionFamilyHarness';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const RUN = Date.now().toString(36);
const AREA = `ar-${RUN}`;
const U = {
  leitor: `pia078-leitor-${RUN}`, // pedidos_ia:read
  decisor: `pia078-decisor-${RUN}`, // pedidos_ia:read + decidir
  semGrupo: `pia078-sem-${RUN}`, // staff sem célula
  worker: `pia078-worker-${RUN}`, // conta não-staff
};
const GRUPOS = { leitor: `Pia078 Leitor ${RUN}`, decisor: `Pia078 Decisor ${RUN}` };

describe('pedidos IA — HTTP real, banco real, engine LIGADO (spec 078, M3b-1)', () => {
  let admin: Pool;
  let app: AppDeFamilia;
  const envAnterior: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string): void => {
    if (!(k in envAnterior)) envAnterior[k] = process.env[k];
    process.env[k] = v;
  };

  async function http(method: string, path: string, uid: string | null, body?: unknown, role = 'admin') {
    const res = await fetch(`${app.url}${path}`, {
      method,
      headers: { ...(uid ? { Authorization: tokenMock(uid, role, 'AR') } : {}), 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
  }

  /** Pedido sintético com N atitudes (versões 1..N). Devolve o id do pedido e os ids das atitudes por versão. */
  async function novoPedido(opts: { versoes?: number; grave?: string; area?: string } = {}) {
    const p = await admin.query(
      `INSERT INTO agentes.pedidos (assunto, descricao, autor, area, grave_gatilho, registro_versao)
       VALUES ('assunto sintetico', 'descricao sintetica', 'sol', $1, $2, 'r1') RETURNING id`,
      [opts.area ?? AREA, opts.grave ?? 'nenhum'],
    );
    const pedidoId = p.rows[0].id as string;
    const atitudes: string[] = [];
    for (let v = 1; v <= (opts.versoes ?? 1); v++) {
      const a = await admin.query(
        `INSERT INTO agentes.pedido_atitudes (pedido_id, versao, degrau, conteudo, caso_teste, metrica_alvo, janela, gatilho_rollback)
         VALUES ($1,$2,1,$3,'caso','metrica','7d','rollback') RETURNING id`,
        [pedidoId, v, `conteudo v${v}`],
      );
      atitudes.push(a.rows[0].id as string);
    }
    return { pedidoId, atitudes };
  }

  const eventos = async (pedidoId: string) =>
    (await admin.query(`SELECT * FROM agentes.pedido_eventos WHERE pedido_id = $1 ORDER BY ts, id`, [pedidoId])).rows;
  const nEventos = async () =>
    Number((await admin.query(`SELECT count(*) AS n FROM agentes.pedido_eventos e JOIN agentes.pedidos p ON p.id = e.pedido_id WHERE p.area = $1`, [AREA])).rows[0].n);

  async function limparPedidos(): Promise<void> {
    const ids = `(SELECT id FROM agentes.pedidos WHERE area = $1)`;
    await admin.query(`DELETE FROM agentes.pedido_eventos WHERE pedido_id IN ${ids}`, [AREA]);
    await admin.query(`DELETE FROM agentes.pedido_atitudes WHERE pedido_id IN ${ids}`, [AREA]);
    await admin.query(`DELETE FROM agentes.pedido_origens WHERE pedido_id IN ${ids}`, [AREA]);
    await admin.query(`DELETE FROM agentes.pedidos WHERE area = $1`, [AREA]);
  }
  const limparIam = () => limparIamFixtures(admin, { uids: Object.values(U), grupos: Object.values(GRUPOS) });

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL });
    await limparPedidos();
    await limparIam();

    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_CATALOG_SYNC_ENABLED', 'true');
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.integrations');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);

    await admin.query(
      `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES
         ($1,$5,'admin','ACTIVE',true,$9), ($2,$6,'admin','ACTIVE',true,$9), ($3,$7,'admin','ACTIVE',true,$9), ($4,$8,'worker','ACTIVE',true,$9)`,
      [U.leitor, U.decisor, U.semGrupo, U.worker, ...Object.values(U).map((u) => `${u}@e2e.local`), TENANT_E2E],
    );
    await grupoComCelulas(admin, { nome: GRUPOS.leitor, uid: U.leitor, celulas: [['pedidos_ia', 'read']] });
    await grupoComCelulas(admin, { nome: GRUPOS.decisor, uid: U.decisor, celulas: [['pedidos_ia', 'read'], ['pedidos_ia', 'decidir']] });

    app = await montarAppDeFamilia({
      enforcedRoutes: 'admin.integrations',
      montarRotas: async ({ app: express, auth, permissions }) => {
        const { createAdminPedidosIaRoutes, createPedidoIaController } = await import('../../src/modules/agentes');
        express.use('/api/admin', createAdminPedidosIaRoutes(createPedidoIaController(), auth, permissions));
      },
    });
  }, 60000);

  afterAll(async () => {
    await app?.fechar();
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await limparPedidos();
    await limparIam();
    await admin.end();
    for (const [k, v] of Object.entries(envAnterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('as 2 células existem no catálogo do banco (migration 552) e a migration NÃO concede a nenhum grupo (o sync do boot só dá ao Acesso Master)', async () => {
    const r = await admin.query(`SELECT action FROM iam.permissions WHERE resource = 'pedidos_ia' AND deprecated_at IS NULL ORDER BY action`);
    expect(r.rows.map((x) => x.action)).toEqual(['decidir', 'read']);
    const g = await admin.query(
      `SELECT g.name FROM iam.group_permissions gp JOIN iam.permissions p ON p.id = gp.permission_id JOIN iam.permission_groups g ON g.id = gp.group_id
        WHERE p.resource = 'pedidos_ia' AND g.name NOT IN ($1,$2,'Acesso Master')`, [GRUPOS.leitor, GRUPOS.decisor]);
    expect(g.rows).toEqual([]);
    const sql = readFileSync(join(__dirname, '../../migrations/552_078_pedidos_ia_cells.sql'), 'utf8');
    expect(sql).not.toMatch(/INSERT\s+INTO\s+iam\.group_permissions/i);
  });

  it('GET lista e GET :id (read sem decidir): 200, com atitude de MAIOR versão e status da view; e ver NÃO deixa evento', async () => {
    const { pedidoId } = await novoPedido({ versoes: 2, grave: 'dado' });
    const antes = await nEventos();

    const lista = await http('GET', `/api/admin/pedidos-ia?area=${AREA}`, U.leitor);
    expect(lista.status).toBe(200);
    expect(lista.body.data).toHaveLength(1);
    const item = lista.body.data[0];
    expect(item).toMatchObject({ id: pedidoId, assunto: 'assunto sintetico', autor: 'sol', area: AREA, grave_gatilho: 'dado', status: 'novo', eventos: [] });
    expect(item.atitude_atual).toMatchObject({ versao: 2, degrau: 1, conteudo: 'conteudo v2', caso_teste: 'caso', metrica_alvo: 'metrica', janela: '7d', gatilho_rollback: 'rollback' });
    expect(typeof item.idade_h).toBe('number');
    expect(typeof item.criado_em).toBe('string');

    const um = await http('GET', `/api/admin/pedidos-ia/${pedidoId}`, U.leitor);
    expect(um.status).toBe(200);
    expect(um.body.data.id).toBe(pedidoId);

    expect(await nEventos()).toBe(antes); // item 51 (controle): GET sem decidir = 0 linhas de evento
  });

  it('filtros: status, grave e área; filtro inválido -> 400; id malformado ou inexistente -> 404', async () => {
    await novoPedido({ grave: 'nenhum' });
    await novoPedido({ grave: 'nunca' });
    const graves = await http('GET', `/api/admin/pedidos-ia?area=${AREA}&grave=true&status=novo`, U.leitor);
    expect(graves.body.data.every((p: any) => p.grave_gatilho !== 'nenhum' && p.status === 'novo')).toBe(true);
    expect(graves.body.data.length).toBeGreaterThanOrEqual(1);
    const leves = await http('GET', `/api/admin/pedidos-ia?area=${AREA}&grave=false`, U.leitor);
    expect(leves.body.data.every((p: any) => p.grave_gatilho === 'nenhum')).toBe(true);
    const outra = await http('GET', `/api/admin/pedidos-ia?area=${AREA}-nao-existe`, U.leitor);
    expect(outra.body.data).toEqual([]);
    expect((await http('GET', `/api/admin/pedidos-ia?status=inventado`, U.leitor)).status).toBe(400);
    expect((await http('GET', `/api/admin/pedidos-ia/nao-e-uuid`, U.leitor)).status).toBe(404);
    expect((await http('GET', `/api/admin/pedidos-ia/00000000-0000-4000-8000-000000000000`, U.leitor)).status).toBe(404);
  });

  it('read SEM decidir: GET 200, mas aceitar/negar/descrever -> 403 e ZERO eventos gravados', async () => {
    const { pedidoId } = await novoPedido();
    expect((await http('GET', `/api/admin/pedidos-ia/${pedidoId}`, U.leitor)).status).toBe(200);
    expect((await http('POST', `/api/admin/pedidos-ia/${pedidoId}/aceitar`, U.leitor)).status).toBe(403);
    expect((await http('POST', `/api/admin/pedidos-ia/${pedidoId}/negar`, U.leitor, { motivo: 'x' })).status).toBe(403);
    expect((await http('POST', `/api/admin/pedidos-ia/${pedidoId}/descrever`, U.leitor, { comentario: 'x' })).status).toBe(403);
    expect(await eventos(pedidoId)).toHaveLength(0);
  });

  it('staff sem célula: GET e POST -> 403', async () => {
    const { pedidoId } = await novoPedido();
    expect((await http('GET', `/api/admin/pedidos-ia`, U.semGrupo)).status).toBe(403);
    expect((await http('POST', `/api/admin/pedidos-ia/${pedidoId}/aceitar`, U.semGrupo)).status).toBe(403);
    expect(await eventos(pedidoId)).toHaveLength(0);
  });

  it('sem credencial -> 401; conta não-staff (worker) -> 403; nenhum evento', async () => {
    const { pedidoId } = await novoPedido();
    expect((await http('GET', `/api/admin/pedidos-ia`, null)).status).toBe(401);
    expect((await http('POST', `/api/admin/pedidos-ia/${pedidoId}/aceitar`, null)).status).toBe(401);
    const w = await http('POST', `/api/admin/pedidos-ia/${pedidoId}/aceitar`, U.worker, undefined, 'worker');
    expect(w.status).toBe(403);
    expect(await eventos(pedidoId)).toHaveLength(0);
  });

  it('aceitar (decidir): 200, exatamente 1 evento humano do staff PRESO à atitude de maior versão; status vira aceito; 2º aceitar -> 409', async () => {
    const { pedidoId, atitudes } = await novoPedido({ versoes: 2 });
    const r = await http('POST', `/api/admin/pedidos-ia/${pedidoId}/aceitar`, U.decisor);
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe('aceito');
    const ev = await eventos(pedidoId);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ id: r.body.data.evento_id, acao: 'aceitar', actor_uid: U.decisor, actor_kind: 'humano', atitude_id: atitudes[1], motivo: null, comentario: null });

    const de = await http('GET', `/api/admin/pedidos-ia/${pedidoId}`, U.leitor);
    expect(de.body.data.status).toBe('aceito');
    expect(de.body.data.eventos).toHaveLength(1);
    expect(de.body.data.eventos[0]).toMatchObject({ acao: 'aceitar', actor_uid: U.decisor, actor_kind: 'humano' });

    expect((await http('POST', `/api/admin/pedidos-ia/${pedidoId}/aceitar`, U.decisor)).status).toBe(409);
    expect((await http('POST', `/api/admin/pedidos-ia/${pedidoId}/negar`, U.decisor, { motivo: 'depois' })).status).toBe(409);
    expect(await eventos(pedidoId)).toHaveLength(1);
  });

  it('negar: sem motivo -> 400 (nada gravado); com motivo -> 200, status negado, motivo no evento', async () => {
    const { pedidoId } = await novoPedido();
    expect((await http('POST', `/api/admin/pedidos-ia/${pedidoId}/negar`, U.decisor, {})).status).toBe(400);
    expect((await http('POST', `/api/admin/pedidos-ia/${pedidoId}/negar`, U.decisor, { motivo: '   ' })).status).toBe(400);
    expect(await eventos(pedidoId)).toHaveLength(0);
    const r = await http('POST', `/api/admin/pedidos-ia/${pedidoId}/negar`, U.decisor, { motivo: 'fora de escopo' });
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe('negado');
    const ev = await eventos(pedidoId);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ acao: 'negar', motivo: 'fora de escopo', actor_uid: U.decisor, actor_kind: 'humano' });
  });

  it('descrever: sem comentário -> 400; com comentário -> 200, status redirecionado, NENHUMA atitude nova; pode repetir e depois decidir', async () => {
    const { pedidoId, atitudes } = await novoPedido();
    expect((await http('POST', `/api/admin/pedidos-ia/${pedidoId}/descrever`, U.decisor, {})).status).toBe(400);
    expect(await eventos(pedidoId)).toHaveLength(0);
    const r1 = await http('POST', `/api/admin/pedidos-ia/${pedidoId}/descrever`, U.decisor, { comentario: 'reduza o escopo' });
    expect(r1.status).toBe(200);
    expect(r1.body.data.status).toBe('redirecionado');
    expect((await http('POST', `/api/admin/pedidos-ia/${pedidoId}/descrever`, U.decisor, { comentario: 'e o prazo' })).status).toBe(200);
    const natit = Number((await admin.query(`SELECT count(*) AS n FROM agentes.pedido_atitudes WHERE pedido_id = $1`, [pedidoId])).rows[0].n);
    expect(natit).toBe(atitudes.length);
    const ev = await eventos(pedidoId);
    expect(ev.map((e) => e.acao)).toEqual(['descrever', 'descrever']);
    expect(ev[0]).toMatchObject({ comentario: 'reduza o escopo', atitude_id: atitudes[0] });
    expect((await http('POST', `/api/admin/pedidos-ia/${pedidoId}/aceitar`, U.decisor)).status).toBe(200);
  });

  it('pedido inexistente: POST -> 404; e a view pedido_status cobre os 4 estados', async () => {
    expect((await http('POST', `/api/admin/pedidos-ia/00000000-0000-4000-8000-000000000000/aceitar`, U.decisor)).status).toBe(404);
    const a = await novoPedido(); const b = await novoPedido(); const c = await novoPedido(); const d = await novoPedido();
    await http('POST', `/api/admin/pedidos-ia/${b.pedidoId}/aceitar`, U.decisor);
    await http('POST', `/api/admin/pedidos-ia/${c.pedidoId}/negar`, U.decisor, { motivo: 'm' });
    await http('POST', `/api/admin/pedidos-ia/${d.pedidoId}/descrever`, U.decisor, { comentario: 'c' });
    const st = await admin.query(`SELECT pedido_id, status FROM agentes.pedido_status WHERE pedido_id = ANY($1)`, [[a, b, c, d].map((x) => x.pedidoId)]);
    const por = Object.fromEntries(st.rows.map((x) => [x.pedido_id, x.status]));
    expect([por[a.pedidoId], por[b.pedidoId], por[c.pedidoId], por[d.pedidoId]]).toEqual(['novo', 'aceito', 'negado', 'redirecionado']);
  });
});
