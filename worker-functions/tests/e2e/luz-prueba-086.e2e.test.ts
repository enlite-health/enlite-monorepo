/**
 * luz-prueba-086.e2e.test.ts — spec 086 (Luz em prueba), CA-5: `POST /api/admin/luz-prueba/turn` contra POSTGRES REAL e HTTP real, com o
 * ENGINE DE PERMISSÃO LIGADO (`admin.integrations`). O triage é um STUB HTTP local (porta efêmera, ou `LUZ_PRUEBA_STUB_PORT`): nada sai da
 * máquina; ele grava o header `x-enlite-gatilho-id` e o corpo recebidos.
 * Prova: sem token -> 401 · staff sem a célula -> 403 (e o triage NÃO é chamado) · com a célula -> 200 com o corpo do triage, gatilho
 * `prueba:<uid>:<sessao>#turno-1` e corpo SEM campo extra · corpo inválido -> 400 (triage não chamado) · teto diário -> 429 (e sob 5 chamadas
 * simultâneas passam exatamente `teto`) · triage fora -> 502 TRIAGE_INDISPONIVEL e o turno é devolvido · o log de erro só tem {uid_hash, sessao, codigo}.
 *
 * Envs SÓ de teste (documentadas no `.env.example`): `TRIAGE_PRUEBA_AUTH=none` (honrado apenas com NODE_ENV != production; sem credencial GCP no CI)
 * e `LUZ_PRUEBA_TETO_DIARIO=3` (idem; em produção o teto é sempre 60). Dados SINTÉTICOS (uids por rodada); limpeza com a conexão de admin.
 */
import http from 'http';
import type { AddressInfo } from 'net';
import { Pool } from 'pg';
import {
  TENANT_E2E,
  tokenMock,
  montarAppDeFamilia,
  limparIamFixtures,
  grupoComCelulas,
  garantirCelulas,
  removerCelulasCriadas,
  type AppDeFamilia,
} from './helpers/permissionFamilyHarness';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const RUN = Date.now().toString(36);
const TETO = 3;
const CELULA = 'luz_prueba:chat';
const U = {
  master: `lp086-master-${RUN}`, // grupo com luz_prueba:chat (no CI o Acesso Master a recebe pelo sync do catálogo)
  semCelula: `lp086-sem-${RUN}`, // staff com UMA célula qualquer, sem luz_prueba:chat
  teto: `lp086-teto-${RUN}`,
  paralelo: `lp086-par-${RUN}`,
  cai: `lp086-cai-${RUN}`,
};
const GRUPOS = { master: `Lp086 Master ${RUN}`, sem: `Lp086 Sem ${RUN}` };
const RESPOSTA_TRIAGE = {
  tipo: 'reply',
  texto: 'respuesta sintetica',
  ferramentas: [{ nome: 'get_worker_status', ok: true, prueba: false }],
  validadores: ['validador-sintetico'],
  prestadora: { nome: 'Prueba Luz PRUEBA' },
};

interface Chamada { gatilho: string | undefined; authorization: string | undefined; corpo: Record<string, unknown> }

describe('Luz (prueba) — rota da plataforma, HTTP real, banco real, engine LIGADO (spec 086, CA-5)', () => {
  let admin: Pool;
  let app: AppDeFamilia;
  let triage: http.Server;
  let chamadas: Chamada[] = [];
  const envAnterior: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string): void => {
    if (!(k in envAnterior)) envAnterior[k] = process.env[k];
    process.env[k] = v;
  };
  let celulasCriadas: string[] = [];

  async function post(uid: string | null, body: unknown) {
    const res = await fetch(`${app.url}/api/admin/luz-prueba/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(uid ? { Authorization: tokenMock(uid, 'admin', 'AR') } : {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
  }
  const valido = (over: Record<string, unknown> = {}) => ({ sessao: 'sessao-1', mensagem: 'hola', historico: [], ...over });
  const turnosDe = async (uid: string) =>
    (await admin.query(`SELECT turnos FROM agentes.luz_prueba_turnos WHERE uid = $1`, [uid])).rows.map((r) => r.turnos as number);
  const limparIam = () => limparIamFixtures(admin, { uids: Object.values(U), grupos: Object.values(GRUPOS) });

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL });

    triage = http.createServer((req, res) => {
      const partes: Buffer[] = [];
      req.on('data', (c) => partes.push(c));
      req.on('end', () => {
        chamadas.push({
          gatilho: req.headers['x-enlite-gatilho-id'] as string | undefined,
          authorization: req.headers.authorization,
          corpo: JSON.parse(Buffer.concat(partes).toString() || '{}'),
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(RESPOSTA_TRIAGE));
      });
    });
    await new Promise<void>((ok) => triage.listen(Number(process.env.LUZ_PRUEBA_STUB_PORT ?? 0), '127.0.0.1', ok));
    const porta = (triage.address() as AddressInfo).port;

    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.integrations');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);
    setEnv('TRIAGE_PRUEBA_URL', `http://127.0.0.1:${porta}`);
    setEnv('TRIAGE_PRUEBA_AUTH', 'none');
    setEnv('LUZ_PRUEBA_TETO_DIARIO', String(TETO));

    await limparIam();
    await admin.query(`DELETE FROM agentes.luz_prueba_turnos WHERE uid = ANY($1)`, [Object.values(U)]);
    await admin.query(
      `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id)
       SELECT u, u || '@e2e.local', 'admin', 'ACTIVE', true, $2 FROM unnest($1::text[]) AS u`,
      [Object.values(U), TENANT_E2E],
    );
    celulasCriadas = await garantirCelulas(admin, [CELULA]);
    await grupoComCelulas(admin, { nome: GRUPOS.master, uid: U.master, celulas: [['luz_prueba', 'chat']] });
    await grupoComCelulas(admin, { nome: GRUPOS.sem, uid: U.semCelula, celulas: [['dashboard', 'read']] });
    for (const uid of [U.teto, U.paralelo, U.cai]) {
      await admin.query(
        `INSERT INTO iam.user_groups (user_id, group_id, tenant_id) SELECT $1, id, $2 FROM iam.permission_groups WHERE name = $3`,
        [uid, TENANT_E2E, GRUPOS.master],
      );
    }

    const { createAdminLuzPruebaRoutes, createLuzPruebaController } = await import('../../src/modules/agentes');
    app = await montarAppDeFamilia({
      enforcedRoutes: 'admin.integrations',
      montarRotas: ({ app: express, auth, permissions }) => {
        express.use('/api/admin', createAdminLuzPruebaRoutes(createLuzPruebaController(), auth, permissions));
      },
    });
  }, 60000);

  afterAll(async () => {
    await app?.fechar();
    if (triage?.listening) await new Promise<void>((ok) => triage.close(() => ok()));
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await admin.query(`DELETE FROM agentes.luz_prueba_turnos WHERE uid = ANY($1)`, [Object.values(U)]);
    await limparIam();
    await removerCelulasCriadas(admin, celulasCriadas);
    await admin.end();
    for (const [k, v] of Object.entries(envAnterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(() => {
    chamadas = [];
  });

  it('sem token -> 401 e o triage não é chamado', async () => {
    const r = await post(null, valido());
    expect(r.status).toBe(401);
    expect(chamadas).toHaveLength(0);
  });

  it('staff SEM a célula luz_prueba:chat -> 403 e o triage não é chamado (a 1ª chave é da plataforma)', async () => {
    const r = await post(U.semCelula, valido());
    expect(r.status).toBe(403);
    expect(chamadas).toHaveLength(0);
    expect(await turnosDe(U.semCelula)).toEqual([]);
  });

  it('com a célula -> 200 com o corpo do triage; gatilho prueba:<uid>:<sessao>#turno-1; corpo SEM campo extra', async () => {
    const r = await post(U.master, valido({ sessao: 'sess_A-1', historico: [{ role: 'user', content: 'oi' }, { role: 'assistant', content: 'hola' }] }));
    expect(r.status).toBe(200);
    expect(r.body).toEqual(RESPOSTA_TRIAGE);
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0].gatilho).toBe(`prueba:${U.master}:sess_A-1#turno-1`);
    expect(Object.keys(chamadas[0].corpo).sort()).toEqual(['historico', 'mensagem', 'sessao', 'uid']);
    expect(chamadas[0].corpo).toMatchObject({ uid: U.master, sessao: 'sess_A-1', mensagem: 'hola' });
    expect(chamadas[0].authorization).toBeUndefined(); // TRIAGE_PRUEBA_AUTH=none (só teste): nenhum token sai
    expect(await turnosDe(U.master)).toEqual([1]);
  });

  it.each([
    ['mensagem vazia', { mensagem: '' }],
    ['mensagem de 1001 chars', { mensagem: 'x'.repeat(1001) }],
    ['sessao com ":" (quebraria o gatilho)', { sessao: 'a:b' }],
    ['sessao de 41 chars', { sessao: 's'.repeat(41) }],
    ['historico com 11 itens', { historico: Array.from({ length: 11 }, () => ({ role: 'user', content: 'x' })) }],
    ['historico com role fora da lista', { historico: [{ role: 'system', content: 'x' }] }],
    ['campo extra no corpo', { uid: 'outra-pessoa' }],
  ])('corpo inválido (%s) -> 400 e o triage não é chamado nem consome turno', async (_nome, over) => {
    const antes = await turnosDe(U.master);
    const r = await post(U.master, valido(over));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ codigo: 'REQUISICAO_INVALIDA' });
    expect(chamadas).toHaveLength(0);
    expect(await turnosDe(U.master)).toEqual(antes);
  });

  it(`teto diário: os ${TETO} primeiros turnos passam (turno-1..${TETO}); o seguinte -> 429 TETO_DIARIO e o triage não é chamado`, async () => {
    for (let n = 1; n <= TETO; n++) {
      const r = await post(U.teto, valido({ sessao: 'teto' }));
      expect(r.status).toBe(200);
      expect(chamadas[n - 1].gatilho).toBe(`prueba:${U.teto}:teto#turno-${n}`);
    }
    const r = await post(U.teto, valido({ sessao: 'teto' }));
    expect(r.status).toBe(429);
    expect(r.body).toEqual({ codigo: 'TETO_DIARIO', limite: TETO });
    expect(chamadas).toHaveLength(TETO);
    expect(await turnosDe(U.teto)).toEqual([TETO]);
  });

  it(`corrida: 5 chamadas SIMULTÂNEAS da mesma pessoa passam exatamente ${TETO} (o UPSERT com o teto é atômico)`, async () => {
    const rs = await Promise.all(Array.from({ length: 5 }, () => post(U.paralelo, valido({ sessao: 'par' }))));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(TETO);
    expect(rs.filter((r) => r.status === 429)).toHaveLength(2);
    expect(chamadas).toHaveLength(TETO);
    expect(new Set(chamadas.map((c) => c.gatilho)).size).toBe(TETO); // cada turno tem o seu N
    expect(await turnosDe(U.paralelo)).toEqual([TETO]);
  });

  it('triage FORA -> 502 TRIAGE_INDISPONIVEL; o turno é devolvido; o log de erro só tem {uid_hash, sessao, codigo}', async () => {
    const { logger } = await import('@shared/logging');
    const erros: unknown[][] = [];
    const espiao = jest.spyOn(logger, 'error').mockImplementation(((...a: unknown[]) => void erros.push(a)) as never);
    try {
      await new Promise<void>((ok) => triage.close(() => ok()));
      const r = await post(U.cai, valido({ sessao: 'cai', mensagem: 'texto-da-conversa-que-nao-pode-vazar' }));
      expect(r.status).toBe(502);
      expect(r.body).toEqual({ codigo: 'TRIAGE_INDISPONIVEL' });
      expect(await turnosDe(U.cai)).toEqual([0]); // a falha da plataforma não gasta a cota
      expect(erros).toHaveLength(1);
      const [campos] = erros[0] as [Record<string, unknown>];
      expect(Object.keys(campos).sort()).toEqual(['codigo', 'sessao', 'uid_hash']);
      expect(campos.sessao).toBe('cai');
      expect(String(campos.uid_hash)).toMatch(/^[0-9a-f]{12}$/);
      expect(String(campos.codigo)).toMatch(/^TRIAGE_INDISPONIVEL:/);
      expect(JSON.stringify(erros)).not.toContain('texto-da-conversa-que-nao-pode-vazar');
      expect(JSON.stringify(erros)).not.toContain(U.cai);
    } finally {
      espiao.mockRestore();
    }
  });
});
