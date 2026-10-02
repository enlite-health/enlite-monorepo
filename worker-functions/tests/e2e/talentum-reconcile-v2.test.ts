/**
 * talentum-reconcile-v2.test.ts — E2E SEM mock da reconciliação Talentum v2 (spec 040 / F5 / T5.3),
 * contra Postgres de verdade (massa SINTÉTICA semeada aqui) e o cliente REAL falando com o stub da v2.
 * Nada sai para a rede; nenhum dado real.
 *
 * Cobre: ligar por publicId, título 1:1, título AMBÍGUO, sem par, já correta, dry-run read-only
 * (prova no Postgres real: a escrita de teste falha), idempotência (2º run = 0) e rollback byte a byte.
 *
 * Sabotagem (T5.3): remover o filtro de ambíguo do use case (`hits.length > 1 ||`) DEVE derrubar este e2e.
 */

import { Pool } from 'pg';
import { createHash } from 'crypto';
import { TalentumApiClient, buildPublicPrescreeningUrl } from '../../src/modules/integration/infrastructure/TalentumApiClient';
import { TalentumV2Stub } from '../../src/modules/integration/infrastructure/__tests__/talentumV2Stub';
import { runReconcileCli, type CliDeps } from '../../src/modules/integration/application/ReconcileTalentumV2Cli';
import { installFetchMethodCounter } from '../../src/modules/integration/application/fetchMethodCounter';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const STUB_PORT = Number(process.env.TALENTUM_STUB_PORT ?? 9915);
const WA = 'https://wa.me/5491100000000?text=Hola%20vacante';
const PUB = (n: number) => `0b0d2c1e-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('Reconciliação Talentum v2 — Postgres real + stub da v2 (sem mock)', () => {
  const stub = new TalentumV2Stub();
  let closeStub: () => Promise<void>;
  let pool: Pool;
  const envBackup = { ...process.env };
  const ids: Record<string, string> = {};

  const jp = async (key: string, title: string, o: { project?: string; pub?: string; url?: string; slug?: string } = {}) => {
    ids[key] = (await pool.query(
      `INSERT INTO job_postings (vacancy_number, title, description, country, status,
              talentum_project_id, talentum_public_id, talentum_whatsapp_url, talentum_slug)
       VALUES (nextval('job_postings_vacancy_number_seq'), $1, '', 'AR', 'SEARCHING', $2, $3, $4, $5) RETURNING id`,
      [title, o.project ?? null, o.pub ?? null, o.url ?? null, o.slug ?? null],
    )).rows[0].id;
  };

  const row = async (key: string) =>
    (await pool.query(
      `SELECT talentum_project_id AS p, talentum_public_id::text AS pub, talentum_slug AS slug, talentum_whatsapp_url AS url
         FROM job_postings WHERE id = $1`, [ids[key]],
    )).rows[0] as { p: string | null; pub: string | null; slug: string | null; url: string | null };

  /** md5 dos 4 campos `talentum_*` de TODAS as linhas, em ordem estável (NULL ≠ ''). */
  const digest = async () => {
    const r = await pool.query(
      `SELECT id, talentum_project_id, talentum_public_id::text, talentum_slug, talentum_whatsapp_url
         FROM job_postings ORDER BY id`,
    );
    return createHash('md5').update(JSON.stringify(r.rows)).digest('hex');
  };
  const waMe = async () =>
    (await pool.query(`SELECT count(*)::int AS n FROM job_postings WHERE talentum_whatsapp_url LIKE 'https://wa.me/%'`)).rows[0].n as number;

  const files = new Map<string, string>();
  const logs: string[] = [];
  const counter = () => installFetchMethodCounter();
  const run = async (argv: string[]) => {
    logs.length = 0;
    const c = counter();
    const deps: CliDeps = {
      openDb: (ro) => new Pool({ connectionString: DATABASE_URL, max: 1, options: ro ? '-c default_transaction_read_only=on' : undefined }),
      openClient: () => TalentumApiClient.create(),
      fs: { exists: (p) => files.has(p), write: (p, t) => void files.set(p, t), read: (p) => files.get(p)! },
      httpStats: () => c.stats(),
      log: (l) => void logs.push(l),
    };
    try {
      return await runReconcileCli(argv, deps);
    } finally {
      c.restore();
    }
  };
  const out = () => logs.join('\n');

  beforeAll(async () => {
    closeStub = (await stub.serve(STUB_PORT)).close;
    process.env.TALENTUM_API_BASE_URL = `http://localhost:${STUB_PORT}`;
    process.env.TALENTUM_API_EMAIL = 'stub-user-e2e-only';
    process.env.TALENTUM_API_PASSWORD = 'stub-key-e2e-only';
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query('TRUNCATE job_postings CASCADE');

    // v2 (stub): P1/P5 com publicId; P2 só por título; P3+P4 mesmo nome; P6 sem vaga
    stub.seed({ _id: 'v2-p1', name: 'EN 1#1', publicId: PUB(1), slug: 'slug1' });
    stub.seed({ _id: 'v2-p2', name: 'EN 2#1', publicId: PUB(2), slug: 'slug2' });
    stub.seed({ _id: 'v2-p3', name: 'DUPLICADO', publicId: PUB(3), slug: 'slug3' });
    stub.seed({ _id: 'v2-p4', name: 'DUPLICADO', publicId: PUB(4), slug: 'slug4' });
    stub.seed({ _id: 'v2-p5', name: 'EN 5#1', publicId: PUB(5), slug: 'slug5' });
    stub.seed({ _id: 'v2-p6', name: 'ORFAO', publicId: PUB(6), slug: 'slug6' });

    await jp('porPublicId', 'qualquer', { project: 'v1-1', pub: PUB(1), url: WA });
    await jp('porTitulo', 'EN 2#1', { project: 'v1-2', url: WA });
    await jp('ambigua', 'DUPLICADO', { project: 'v1-3', url: WA });
    await jp('semParPublicId', 'x', { project: 'v1-4', pub: PUB(99), url: WA });
    await jp('semParTitulo', 'NAO EXISTE NA V2', { project: 'v1-5' });
    await jp('jaCorreta', 'EN 5#1', { project: 'v2-p5', pub: PUB(5), slug: 'slug5', url: buildPublicPrescreeningUrl(PUB(5)) });
    await jp('livre', 'sem talentum');
  });

  afterAll(async () => {
    await pool.query('TRUNCATE job_postings CASCADE');
    await pool.end();
    await closeStub();
    process.env = envBackup;
  });

  it('1) DRY-RUN: read-only provado no Postgres real, contagens certas, 0 escritas no banco e na Talentum', async () => {
    const before = await digest();
    const waBefore = await waMe();
    stub.calls.length = 0;

    expect(await run(['--csv-out', '/rb/dry.csv'])).toBe(0);

    expect(out()).toContain('default_transaction_read_only = on');
    expect(out()).toMatch(/prova read-only: CREATE TEMP TABLE reconcile_ro_probe\(i int\) -> cannot execute CREATE TABLE in a read-only transaction/);
    expect(out()).toContain('ligadas por publicId: 1 · por título: 1 · sem par: 2 · ambíguas: 1 · inválidas: 0 · já corretas: 1');
    expect(out()).toContain('projetos v2 sem vaga par (o sync de vagas criaria, no máx.): 3'); // P3, P4 (ambíguo) e P6
    expect(out()).toContain(`ambíguas (job_posting_id): ${ids.ambigua}`);
    expect(out()).toContain(`wa.me antes: ${waBefore} · depois: ${waBefore}`);
    expect(await digest()).toBe(before);
    expect(stub.calls.every((c) => c.method === 'GET' || c.path === '/auth/login')).toBe(true);
    expect(stub.calls.some((c) => c.method !== 'GET' && c.path !== '/auth/login')).toBe(false);
    // o CSV de rollback só carrega ids e valores antigos de talentum_* — nunca título
    const csv = files.get('/rb/dry.csv')!;
    expect(csv.split('\n').filter(Boolean)).toHaveLength(1 + 2);
    expect(csv).not.toContain('EN 2#1');
    expect(csv).not.toContain('DUPLICADO');
  });

  it('2) EXECUTE: liga por publicId e por título 1:1; ambígua, sem par, já correta e livre ficam INTACTAS', async () => {
    const untouched = { ambigua: await row('ambigua'), semParPublicId: await row('semParPublicId'), semParTitulo: await row('semParTitulo'), jaCorreta: await row('jaCorreta'), livre: await row('livre') };
    const before = await digest();

    expect(await run(['--execute', '--csv-out', '/rb/exec.csv'])).toBe(0);

    expect(out()).toContain('aplicadas: 2');
    expect(await row('porPublicId')).toEqual({ p: 'v2-p1', pub: PUB(1), slug: 'slug1', url: buildPublicPrescreeningUrl(PUB(1)) });
    expect(await row('porTitulo')).toEqual({ p: 'v2-p2', pub: PUB(2), slug: 'slug2', url: buildPublicPrescreeningUrl(PUB(2)) });
    for (const [k, v] of Object.entries(untouched)) expect(await row(k)).toEqual(v);
    expect(await digest()).not.toBe(before);
    process.stdout.write(`[T5.2] md5 talentum_* ANTES do execute: ${before} · DEPOIS do execute: ${await digest()}\n`);
    expect(out()).toContain('wa.me antes: 4 · depois: 2');
    files.set('/rb/before.digest', before);
  });

  it('3) IDEMPOTENTE: 2º run = 0 mudanças e o banco não se mexe', async () => {
    const after1 = await digest();
    expect(await run(['--execute', '--csv-out', '/rb/exec2.csv'])).toBe(0);
    expect(out()).toContain('ligadas por publicId: 0 · por título: 0');
    expect(out()).toContain('aplicadas: 0');
    expect(out()).toContain('já corretas: 3');
    expect(await digest()).toBe(after1);
  });

  it('4) ROLLBACK a partir do CSV devolve o banco BYTE A BYTE ao estado anterior (NULL inclusive)', async () => {
    expect(await digest()).not.toBe(files.get('/rb/before.digest'));
    expect(await run(['--rollback', '/rb/exec.csv'])).toBe(0);
    expect(out()).toContain('ROLLBACK: 2 vagas restauradas');
    expect(await digest()).toBe(files.get('/rb/before.digest'));
    process.stdout.write(`[T5.2] md5 talentum_* DEPOIS do rollback: ${await digest()} (esperado = ${files.get('/rb/before.digest')})\n`);
    expect(await row('porTitulo')).toEqual({ p: 'v1-2', pub: null, slug: null, url: WA });
  });

  it('5) projeto já gravado em OUTRA vaga (índice único): ninguém é ligado e o run não estoura', async () => {
    await pool.query(`UPDATE job_postings SET talentum_project_id = 'v2-p1' WHERE id = $1`, [ids.livre]);
    const before = await digest();
    expect(await run(['--execute', '--csv-out', '/rb/exec3.csv'])).toBe(0);
    const ambiguousLine = logs.find((l) => l.startsWith('ambíguas (job_posting_id):'))!;
    expect(ambiguousLine).toContain(ids.porPublicId); // a do publicId (projeto ocupado por `livre`) + a do DUPLICADO
    expect(ambiguousLine).toContain(ids.ambigua);
    expect(out()).toContain('aplicadas: 1'); // só a de título (v2-p2)
    expect(await row('porPublicId')).toMatchObject({ p: 'v1-1' });
    expect(await digest()).not.toBe(before);
  });
});
