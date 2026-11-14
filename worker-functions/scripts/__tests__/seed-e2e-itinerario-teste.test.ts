import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Api, assertE2eApiUrl, assertE2eDsn, ensureTestWorker, workerAccount, pontoAoNorte, seedVagasRaio, cleanup, ZONA_BASE, SOBRENOMES_DO_MARCADOR, PACIENTES_SEED, seedWorkerOnly, completeTestWorker, prepararPrestadora, linhasDeIds, main, realDeps, entrarNoPool, E2E_API_URL, type SeedDeps } from '../seed-e2e-itinerario-teste';

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

  const SUBST = { SEED_WORKER_EMAIL: 'qa.worker.subst@enlite.test', SEED_WORKER_SECRET: 'qa-prd-worker-subst-password' };
  const VAGA = '33333333-3333-4333-8333-333333333333';

  it('T-F2a-79 --substitute: cadastro com perfil próprio, pool QUICK_RESPONSE_TEAM na vaga dada e nenhuma alocação', async () => {
    const { deps, seen } = fakeWf('REGISTERED');
    const sqls: string[] = [];
    const lines: string[] = [];
    deps.sql = (statement, vars) => {
      sqls.push(`${statement} ${JSON.stringify(vars)}`);
      return 'aaaaaaaa-0000-4000-8000-0000000000aa|QUICK_RESPONSE_TEAM';
    };
    deps.log = (l) => lines.push(l);
    await main(['--substitute', '--vacancy', VAGA], deps, SUBST);
    const body = JSON.parse(seen.find((c) => c.path === '/api/workers/me/general-info')?.body ?? '{}');
    expect([body.documentNumber, body.phone]).toEqual(['QA077-SUB-0001', '1100000078']);
    expect(sqls).toHaveLength(1);
    expect(sqls[0]).toContain("'QUICK_RESPONSE_TEAM'");
    expect(sqls[0]).toContain(`"v":"${VAGA}"`);
    expect(seen.filter((c) => c.path.includes('/allocations') || c.path.includes('/patients'))).toEqual([]);
    expect(lines.filter((l) => /^(WORKER_ID|APPLICATION_ID|VACANCY_ID)=/.test(l))).toEqual([
      'WORKER_ID=11111111-1111-4111-8111-111111111111',
      'APPLICATION_ID=aaaaaaaa-0000-4000-8000-0000000000aa',
      `VACANCY_ID=${VAGA}`,
    ]);
  });

  it('T-F2a-79 main recusa --substitute com a conta at, sem --vacancy válida ou junto de --cleanup/--worker-only', async () => {
    const ds = [spyDeps(), spyDeps(), spyDeps(), spyDeps()];
    await expect(main(['--substitute', '--vacancy', VAGA], ds[0], {})).rejects.toThrow(/nunca a qa.worker.at/);
    await expect(main(['--substitute'], ds[1], SUBST)).rejects.toThrow(/--vacancy/);
    await expect(main(['--substitute', '--cleanup', '--vacancy', VAGA], ds[2], SUBST)).rejects.toThrow(/não combina/);
    await expect(main(['--substitute', '--worker-only', '--vacancy', VAGA], ds[3], SUBST)).rejects.toThrow(/não combina/);
    for (const d of ds) expect(d.calls).toEqual({ fetch: 0, token: 0, sql: 0 });
  });

  it('T-F2a-79 entrarNoPool recusa candidatura fora de QUICK_RESPONSE_TEAM (o seed nunca move etapa)', () => {
    const deps: SeedDeps = { ...spyDeps(), sql: () => 'aaaaaaaa-0000-4000-8000-0000000000aa|SELECTED' };
    expect(() => entrarNoPool(deps, '11111111-1111-4111-8111-111111111111', VAGA)).toThrow(/etapa inesperada \(SELECTED\)/);
  });

  // fake com estado para os pacientes de vaga (T-F2a-39)
  const vagasFake = (): { deps: SeedDeps; posts: string[]; sqls: string[]; api: () => Api; deleted: string[] } => {
    const posts: string[] = [];
    const sqls: string[] = [];
    const deleted: string[] = [];
    let n = 0;
    const uid = (): string => `${String(++n).padStart(8, '0')}-0000-4000-8000-000000000000`;
    const patients: Record<string, unknown>[] = [];
    const addresses: Record<string, Record<string, unknown>[]> = {};
    const vacancies: Record<string, Record<string, unknown>[]> = {};
    const respond = (data: unknown, status = 200): { status: number; text(): Promise<string> } => ({ status, text: async () => JSON.stringify({ data }) });
    const deps: SeedDeps = {
      ...spyDeps(),
      getToken: () => 'tok-worker',
      getAdminToken: () => 'tok-admin',
      sql: (st) => { sqls.push(st); return '1'; },
      fetch: async (url, init) => {
        const path = url.replace(E2E_API_URL, '');
        const key = `${init.method} ${path.replace(/[0-9a-f]{8}-0000-4000-8000-000000000000/g, ':id')}`;
        if (init.method !== 'GET') posts.push(key);
        const pid = path.match(/patients\/([0-9a-f-]{36})/)?.[1] ?? '';
        if (key === 'GET /api/admin/patients?search=QA077') return respond(patients);
        if (key === 'POST /api/admin/patients') {
          const b = JSON.parse(init.body as string);
          const p = { id: uid(), firstName: b.firstName, lastName: b.lastName, caseNumber: 100 + patients.length, isTest: false };
          patients.push(p);
          return respond(p, 201);
        }
        if (key === 'PATCH /api/admin/patients/:id/test-flag') { const p = patients.find((x) => x.id === pid); if (p) p.isTest = true; return respond({}); }
        if (key === 'GET /api/admin/patients/:id/addresses') return respond(addresses[pid] ?? []);
        if (key === 'POST /api/admin/patients/:id/addresses') {
          const a = { id: uid(), address_formatted: JSON.parse(init.body as string).address_formatted };
          (addresses[pid] ??= []).push(a);
          return respond(a, 201);
        }
        if (key === 'GET /api/admin/patients/:id/vacancies') return respond(vacancies[pid] ?? []);
        if (key === 'POST /api/admin/vacancies') {
          const b = JSON.parse(init.body as string);
          expect(b.is_test).toBe(true);
          expect(b.is_draft).toBe(true);
          const v = { id: uid() };
          (vacancies[b.patient_id] ??= []).push(v);
          return respond(v, 201);
        }
        if (key === 'DELETE /api/admin/patients/:id') { deleted.push(pid); return respond({}); }
        if (key.startsWith('GET /api/admin/patients/:id/')) return respond({ services: [] });
        return respond({});
      },
    };
    return { deps, posts, sqls, deleted, api: () => new Api(E2E_API_URL, deps, workerAccount({})) };
  };
  const WID = '99999999-0000-4000-8000-000000000000';

  it('T-F2a-39 pontoAoNorte desloca 3, 12 e 60 km em latitude', () => {
    expect(pontoAoNorte(ZONA_BASE, 3)).toEqual({ lat: -37.9753507, lng: -57.5575 });
    expect(pontoAoNorte(ZONA_BASE, 12)).toEqual({ lat: -37.8945027, lng: -57.5575 });
    expect(pontoAoNorte(ZONA_BASE, 60)).toEqual({ lat: -37.4633133, lng: -57.5575 });
  });

  it('T-F2a-39 semeia 3 vagas is_test e is_draft', async () => {
    const f = vagasFake();
    const out = await seedVagasRaio(f.api(), f.deps, WID);
    expect(out.map((o) => o.km)).toEqual([3, 12, 60]);
    expect(f.posts.filter((p) => p === 'POST /api/admin/vacancies')).toHaveLength(3);
    expect(f.posts.filter((p) => p === 'PATCH /api/admin/patients/:id/test-flag')).toHaveLength(3);
    expect(f.sqls).toHaveLength(3);
    for (const q of f.sqls) expect(q).toContain('is_test = true');
  });

  it('T-F2a-39 2ª execução não cria paciente nem vaga', async () => {
    const f = vagasFake();
    await seedVagasRaio(f.api(), f.deps, WID);
    f.posts.length = 0;
    await seedVagasRaio(f.api(), f.deps, WID);
    expect(f.posts.filter((p) => /^POST /.test(p))).toEqual([]);
  });

  it('T-F2a-39 --cleanup purga os 3 pacientes de vaga', async () => {
    const f = vagasFake();
    await seedVagasRaio(f.api(), f.deps, WID);
    expect(SOBRENOMES_DO_MARCADOR).toEqual(['Paciente Itinerario', 'Paciente Dos', 'Paciente Tres', 'Vaga 3km', 'Vaga 12km', 'Vaga 60km']);
    await cleanup(f.api(), f.deps);
    expect(f.deleted).toHaveLength(3);
  });

  it('T-F3a-pacientes-09 PACIENTES_SEED tem 3 pacientes e 2 primeiros nomes', () => {
    expect(PACIENTES_SEED).toHaveLength(3);
    expect(new Set(PACIENTES_SEED.map((p) => p.firstName)).size).toBe(2);
    expect(new Set(PACIENTES_SEED.map((p) => p.lastName)).size).toBe(3);
  });

  it('T-F3a-pacientes-09 faixas dos 3 pacientes não se cruzam no mesmo dia', () => {
    const porDia = new Map<number, number>();
    for (const p of PACIENTES_SEED) for (const f of p.schedule) porDia.set(f.dayOfWeek, (porDia.get(f.dayOfWeek) ?? 0) + 1);
    expect([...porDia.values()].every((n) => n === 1)).toBe(true);
  });

  it('T-F3a-pacientes-09 --cleanup purga os 2 pacientes novos', async () => {
    const deleted: string[] = [];
    const a = 'aaaaaaaa-0000-4000-8000-000000000001';
    const b = 'aaaaaaaa-0000-4000-8000-000000000002';
    const deps: SeedDeps = {
      ...spyDeps(),
      getToken: () => 'tok-worker',
      getAdminToken: () => 'tok-admin',
      fetch: async (url, init) => {
        const path = url.replace(E2E_API_URL, '');
        let data: unknown = {};
        if (path === '/api/admin/patients?search=QA077') {
          data = [{ id: a, firstName: 'QA077', lastName: 'Paciente Dos', isTest: true }, { id: b, firstName: 'QA077Tres', lastName: 'Paciente Tres', isTest: true }];
        } else if (init.method === 'DELETE' && path.startsWith('/api/admin/patients/')) deleted.push(path);
        else if (path.endsWith('/itinerary')) data = { services: [] };
        else if (path.endsWith('/contracted-services')) data = { services: [] };
        return { status: 200, text: async () => JSON.stringify({ data }) };
      },
      sql: () => '',
    };
    await cleanup(new Api(E2E_API_URL, deps, workerAccount({})), deps);
    expect(deleted).toEqual([`/api/admin/patients/${a}`, `/api/admin/patients/${b}`]);
  });
});
