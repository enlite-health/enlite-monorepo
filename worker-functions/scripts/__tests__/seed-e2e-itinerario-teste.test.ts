import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Api, assertE2eApiUrl, assertE2eDsn, ensureTestWorker, workerAccount, seedWorkerOnly, completeTestWorker, prepararPrestadora, linhasDeIds, main, realDeps, E2E_API_URL, type SeedDeps } from '../seed-e2e-itinerario-teste';

const PRD_LIKE = [
  'https://worker-functions-prd.example.run.app',
  'http://localhost:8080',
  'https://worker-functions-byh3gvl5yq-tl.a.run.app.evil.com',
  'http://worker-functions-byh3gvl5yq-tl.a.run.app',
  'https://worker-functions-byh3gvl5yq-tl.a.run.app:8443',
  'not a url',
];

function spyDeps(): SeedDeps & { calls: { fetch: number; token: number; sql: number } } {
  const calls = { fetch: 0, token: 0, sql: 0 };
  return {
    calls,
    fetch: async () => { calls.fetch += 1; return { status: 200, text: async () => '{}' }; },
    getToken: () => { calls.token += 1; throw new Error('parou-no-token'); },
    getAdminToken: () => { calls.token += 1; throw new Error('parou-no-token'); },
    sql: () => { calls.sql += 1; return ''; },
    log: () => undefined,
  };
}

describe('seed-e2e-itinerario-teste — guarda de alvo (só prd)', () => {
  it.each(PRD_LIKE)('assertE2eApiUrl recusa %s', (url) => {
    expect(() => assertE2eApiUrl(url)).toThrow(/RECUSADO|inválida/);
  });

  it('assertE2eApiUrl aceita a URL de prd', () => {
    expect(assertE2eApiUrl(E2E_API_URL)).toBe(E2E_API_URL);
  });

  it.each(['postgresql://enlite_app@127.0.0.1:5435/enlite_ar', 'postgresql://enlite_app@127.0.0.1:5439/gbrain', 'postgresql://enlite_app@10.0.0.1:5434/enlite_ar'])(
    'assertE2eDsn recusa %s', (dsn) => {
      expect(() => assertE2eDsn(dsn)).toThrow(/RECUSADO/);
    });

  it.each(PRD_LIKE)('main recusa %s ANTES de qualquer rede, token ou SQL (morre se a guarda sair)', async (url) => {
    const deps = spyDeps();
    await expect(main(['--api-url', url], deps)).rejects.toThrow();
    expect(deps.calls).toEqual({ fetch: 0, token: 0, sql: 0 });
  });

  it('controle positivo: com a URL de prd o main passa da guarda e chega ao token', async () => {
    const deps = spyDeps();
    await expect(main(['--api-url', E2E_API_URL], deps)).rejects.toThrow('parou-no-token');
    expect(deps.calls.token).toBe(1);
  });

  it('--cleanup também passa pela guarda', async () => {
    const deps = spyDeps();
    await expect(main(['--cleanup', '--api-url', PRD_LIKE[0]], deps)).rejects.toThrow(/RECUSADO/);
    expect(deps.calls.token).toBe(0);
  });

  it('T-F0a-srv-36 recusa o host antigo e aceita o WF de prd', () => {
    expect(() => assertE2eApiUrl('https://worker-functions-vtf37eainq-tl.a.run.app')).toThrow(/RECUSADO/);
    expect(assertE2eApiUrl('https://worker-functions-byh3gvl5yq-tl.a.run.app')).toBe('https://worker-functions-byh3gvl5yq-tl.a.run.app');
  });

  it('T-F0a-srv-36 recusa DSN fora de 127.0.0.1:5436/enlite_ar', () => {
    for (const dsn of ['postgresql://enlite_app@127.0.0.1:5436/gbrain', 'postgresql://enlite_app@127.0.0.1:5435/enlite_ar', 'postgresql://enlite_app@10.0.0.1:5436/enlite_ar']) {
      expect(() => assertE2eDsn(dsn)).toThrow(/RECUSADO/);
    }
    expect(assertE2eDsn('postgresql://enlite_app@127.0.0.1:5436/enlite_ar')).toContain(':5436/enlite_ar');
  });

  it('T-F0a-srv-36 init com corpo {} antes do GET me e test-flag logo depois', async () => {
    const seen: { method: string; path: string; body?: string; auth?: string }[] = [];
    const id = '11111111-1111-4111-8111-111111111111';
    const deps: SeedDeps = {
      ...spyDeps(),
      fetch: async (url, init) => {
        const path = url.replace(E2E_API_URL, '');
        seen.push({ method: init.method, path, body: init.body as string | undefined, auth: init.headers.Authorization });
        const data = path === '/api/workers/init' ? { status: 'ok' } : { id };
        return { status: 200, text: async () => JSON.stringify({ data }) };
      },
      getToken: () => 'tok-worker',
      getAdminToken: () => 'tok-admin',
    };
    await expect(ensureTestWorker(new Api(E2E_API_URL, deps, workerAccount({})), deps)).resolves.toBe(id);
    expect(seen.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /api/workers/init',
      'GET /api/workers/me',
      `PATCH /api/admin/workers/${id}/test-flag`,
    ]);
    expect(seen[0].body).toBe('{}');
    expect(seen[0].auth).toBe('Bearer tok-worker');
    expect(seen[2].body).toBe('{"isTest":true}');
    expect(seen[2].auth).toBe('Bearer tok-admin');
  });

  it('T-F0a-srv-36 sem SEED_ADMIN_TOKEN o realDeps recusa', () => {
    const old = process.env.SEED_ADMIN_TOKEN;
    delete process.env.SEED_ADMIN_TOKEN;
    try {
      expect(() => realDeps().getAdminToken()).toThrow(/SEED_ADMIN_TOKEN/);
      process.env.SEED_ADMIN_TOKEN = 'x';
      expect(realDeps().getAdminToken()).toBe('x');
    } finally {
      if (old === undefined) delete process.env.SEED_ADMIN_TOKEN;
      else process.env.SEED_ADMIN_TOKEN = old;
    }
  });

  it('T-F0a-srv-36 todo SQL do cleanup filtra is_test', () => {
    const src = readFileSync(join(__dirname, '..', 'seed-e2e-itinerario-teste.ts'), 'utf8');
    const block = src.slice(src.indexOf('export async function cleanup'), src.indexOf('// ── CLI'));
    const sql = block.slice(block.indexOf('deps.sql('), block.indexOf("{ pat: patientId }"));
    const stmts = sql.split(';').filter((x) => /DELETE FROM/.test(x));
    expect(stmts).toHaveLength(3);
    for (const st of stmts) {
      expect(st).toContain("AND EXISTS (SELECT 1 FROM patients WHERE id = :'pat'::uuid AND is_test = true)");
    }
  });

  it('T-F0a-srv-36 o script não cria pagador, contrato nem conta de staff', () => {
    const src = readFileSync(join(__dirname, '..', 'seed-e2e-itinerario-teste.ts'), 'utf8');
    for (const forbidden of ['/api/admin/catalogs/insurance-providers', '/contract-link', 'qa.admin@enlite.test']) {
      expect(src.split(forbidden).length - 1).toBe(0);
    }
  });

  it('T-F0a-srv-36 linhasDeIds imprime as chaves que o T-F0b-16 lê', () => {
    const u = (n: number): string => `${n}0000000-0000-4000-8000-000000000000`;
    const lines = linhasDeIds({ patientId: u(1), addressId: u(2), serviceId: u(3), projectId: u(4), vacancyId: u(5), workerId: u(6), applicationId: u(7), slotIds: [], allocationIds: [] });
    expect(lines.map((l) => l.split('=')[0])).toEqual(['PATIENT_ID', 'SERVICE_ID', 'APPLICATION_ID', 'WORKER_ID', 'VACANCY_ID']);
    expect(lines[3]).toBe(`WORKER_ID=${u(6)}`);
  });

  const fakeWf = (finalStatus: string): { deps: SeedDeps; seen: { method: string; path: string; body?: string }[]; sqlCalls: () => number } => {
    const seen: { method: string; path: string; body?: string }[] = [];
    let sqlN = 0;
    const id = '11111111-1111-4111-8111-111111111111';
    let meCalls = 0;
    const deps: SeedDeps = {
      ...spyDeps(),
      fetch: async (url, init) => {
        const path = url.startsWith(E2E_API_URL) ? url.slice(E2E_API_URL.length) : 'GCS';
        seen.push({ method: init.method, path, body: init.body as string | undefined });
        let data: Record<string, unknown> = {};
        if (path === '/api/workers/init') data = { status: 'ok' };
        else if (path === '/api/workers/me') { meCalls += 1; data = { id, status: meCalls >= 2 ? finalStatus : 'INCOMPLETE_REGISTER', missingFields: ['x'] }; }
        else if (path === '/api/workers/me/documents/upload-url') data = { signedUrl: 'https://storage.example/up', filePath: 'p' };
        return { status: 200, text: async () => JSON.stringify({ data }) };
      },
      getToken: () => 'tok-worker',
      getAdminToken: () => 'tok-admin',
      sql: () => { sqlN += 1; return ''; },
    };
    return { deps, seen, sqlCalls: () => sqlN };
  };

  it('T-F0a-srv-36 prepararPrestadora faz init, test-flag e só depois completa o cadastro', async () => {
    const { deps, seen } = fakeWf('REGISTERED');
    await expect(prepararPrestadora(new Api(E2E_API_URL, deps, workerAccount({})), deps)).resolves.toBe('11111111-1111-4111-8111-111111111111');
    const calls = seen.map((c) => `${c.method} ${c.path}`);
    const docs = ['POST /api/workers/me/documents/upload-url', 'PUT GCS', 'POST /api/workers/me/documents/save'];
    expect(calls).toEqual([
      'POST /api/workers/init',
      'GET /api/workers/me',
      'PATCH /api/admin/workers/11111111-1111-4111-8111-111111111111/test-flag',
      'PUT /api/workers/me/general-info',
      'PUT /api/workers/me/service-area',
      'PUT /api/workers/me/availability',
      ...docs, ...docs, ...docs, ...docs,
      'GET /api/workers/me',
    ]);
  });

  it('T-F0a-srv-36 prepararPrestadora para se o GET me final não der REGISTERED', async () => {
    const { deps, sqlCalls } = fakeWf('INCOMPLETE_REGISTER');
    await expect(prepararPrestadora(new Api(E2E_API_URL, deps, workerAccount({})), deps)).rejects.toThrow(/REGISTERED/);
    expect(sqlCalls()).toBe(0);
  });

  it('T-F0a-srv-36 general-info com os valores sintéticos fixos', async () => {
    const { deps, seen } = fakeWf('REGISTERED');
    await completeTestWorker(new Api(E2E_API_URL, deps, workerAccount({})), deps);
    const body = JSON.parse(seen.find((c) => c.path === '/api/workers/me/general-info')?.body ?? '{}');
    expect(body.documentNumber).toBe('QA077-AT-0001');
    expect(body.phone).toBe('1100000077');
    expect(body.firstName).toBe('QA077');
  });

  it('T-F0b-19 workerAccount sem env devolve a conta at', () => {
    expect(workerAccount({})).toEqual({ email: 'qa.worker.at@enlite.test', secret: 'qa-prd-worker-at-password' });
  });

  it('T-F0b-19 workerAccount com SEED_WORKER_EMAIL e SEED_WORKER_SECRET devolve a ks', () => {
    expect(workerAccount({ SEED_WORKER_EMAIL: 'qa.worker.ks@enlite.test', SEED_WORKER_SECRET: 'qa-prd-worker-ks-password' })).toEqual({
      email: 'qa.worker.ks@enlite.test', secret: 'qa-prd-worker-ks-password',
    });
  });

  it('T-F0b-19 workerAccount recusa conta fora de qa.*@enlite.test', () => {
    expect(() => workerAccount({ SEED_WORKER_EMAIL: 'pessoa.real@gmail.com' })).toThrow(/RECUSADO/);
    expect(() => workerAccount({ SEED_WORKER_EMAIL: 'qa.worker.ks@enlite.test', SEED_WORKER_SECRET: 'outro-secret' })).toThrow(/RECUSADO/);
  });

  it('T-F0b-19 --worker-only chama só init, me e test-flag, com corpo {} no init', async () => {
    const seen: { method: string; path: string; body?: string }[] = [];
    const id = '22222222-2222-4222-8222-222222222222';
    let sqlN = 0;
    const deps: SeedDeps = {
      ...spyDeps(),
      fetch: async (url, init) => {
        const path = url.replace(E2E_API_URL, '');
        seen.push({ method: init.method, path, body: init.body as string | undefined });
        return { status: 200, text: async () => JSON.stringify({ data: path === '/api/workers/init' ? { status: 'ok' } : { id } }) };
      },
      getToken: () => 'tok-worker',
      getAdminToken: () => 'tok-admin',
      sql: () => { sqlN += 1; return ''; },
    };
    await expect(seedWorkerOnly(new Api(E2E_API_URL, deps, workerAccount({})), deps)).resolves.toBe(id);
    expect(seen.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /api/workers/init', 'GET /api/workers/me', `PATCH /api/admin/workers/${id}/test-flag`]);
    expect(seen[0].body).toBe('{}');
    expect(sqlN).toBe(0);
  });

  it('T-F0b-19 main recusa --cleanup com a conta ks e --cleanup junto de --worker-only', async () => {
    const ks = { SEED_WORKER_EMAIL: 'qa.worker.ks@enlite.test', SEED_WORKER_SECRET: 'qa-prd-worker-ks-password' };
    const d1 = spyDeps();
    await expect(main(['--cleanup'], d1, ks)).rejects.toThrow(/só com a conta qa.worker.at/);
    const d2 = spyDeps();
    await expect(main(['--cleanup', '--worker-only'], d2, {})).rejects.toThrow(/exclusivos/);
    expect(d1.calls).toEqual({ fetch: 0, token: 0, sql: 0 });
    expect(d2.calls).toEqual({ fetch: 0, token: 0, sql: 0 });
  });
});
