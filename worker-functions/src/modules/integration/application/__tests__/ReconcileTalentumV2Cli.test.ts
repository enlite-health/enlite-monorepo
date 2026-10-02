import { runReconcileCli, type CliDeps } from '../ReconcileTalentumV2Cli';
import { parseRollbackCsv } from '../ReconcileRollbackCsv';
import { FakeReconcileDb } from './fakeReconcileDb';
import { fakeTalentumV2Client, type FakeProject } from './fakeTalentumV2Client';

const PUB = (n: number) => `0b0d2c1e-0000-4000-8000-${String(n).padStart(12, '0')}`;
const WA = 'https://wa.me/5491100000000?text=Hola';

function setup(projects: FakeProject[] = [{ projectId: 'v2-1', title: 'a', publicId: PUB(1), slug: 's1' }]) {
  const db = new FakeReconcileDb();
  db.add({ id: 'jp-1', talentum_project_id: 'v1-1', talentum_public_id: PUB(1), talentum_whatsapp_url: WA });
  db.add({ id: 'jp-sem-par', title: 'nada', talentum_project_id: 'v1-2' });
  const files = new Map<string, string>();
  const logs: string[] = [];
  const openDb = jest.fn((_ro: boolean) => db);
  const deps: CliDeps = {
    openDb,
    openClient: async () => fakeTalentumV2Client(projects),
    fs: {
      exists: (p) => files.has(p),
      write: (p, t) => void files.set(p, t),
      read: (p) => files.get(p)!,
    },
    httpStats: () => ({ byMethod: { GET: 3, POST: 1 }, writes: 0 }),
    log: (l) => void logs.push(l),
  };
  return { db, files, logs, deps, openDb, out: () => logs.join('\n') };
}

describe('runReconcileCli — argumentos', () => {
  it.each([
    [['--rollback'], '--rollback exige o caminho'],
    [['--csv-out'], '--csv-out exige o caminho'],
    [['--csv-out', '--execute'], '--csv-out exige o caminho'],
    [['--execute', '--rollback', 'x.csv'], 'não combinam'],
    [['--execute'], '--execute exige --csv-out'],
  ])('%j → rc 2 e uso, sem abrir banco', async (argv, msg) => {
    const s = setup();
    expect(await runReconcileCli(argv, s.deps)).toBe(2);
    expect(s.out()).toContain(msg);
    expect(s.openDb).not.toHaveBeenCalled();
  });
});

describe('runReconcileCli — dry-run (padrão)', () => {
  it('abre o banco READ-ONLY, prova a trava, imprime contagens e wa.me antes = depois, sem escrever', async () => {
    const s = setup();
    const before = s.db.snapshot();

    expect(await runReconcileCli([], s.deps)).toBe(0);

    expect(s.openDb).toHaveBeenCalledWith(true);
    expect(s.out()).toContain('default_transaction_read_only = on');
    expect(s.out()).toContain('cannot execute CREATE TABLE in a read-only transaction');
    expect(s.out()).toContain('DRY-RUN — projetos v2=1 | vagas candidatas=2');
    expect(s.out()).toContain('ligadas por publicId: 1 · por título: 0 · sem par: 1 · ambíguas: 0 · inválidas: 0 · já corretas: 0');
    expect(s.out()).toContain('sem par (job_posting_id): jp-sem-par');
    expect(s.out()).toContain('ambíguas (job_posting_id): -');
    expect(s.out()).toContain('wa.me antes: 1 · depois: 1');
    expect(s.out()).toContain('escritas (≠GET, fora do login): 0');
    expect(s.db.snapshot()).toBe(before);
    expect(s.db.ended).toBe(1);
  });

  it('sem nenhuma vaga sem par, a linha mostra "-"', async () => {
    const s = setup();
    s.db.rows = s.db.rows.filter((r) => r.id === 'jp-1');
    expect(await runReconcileCli([], s.deps)).toBe(0);
    expect(s.out()).toContain('sem par (job_posting_id): -');
  });

  it('--csv-out no dry-run grava o rollback que SERIA usado (só valores antigos), sem escrever no banco', async () => {
    const s = setup();
    expect(await runReconcileCli(['--csv-out', '/r/rb.csv'], s.deps)).toBe(0);
    expect(parseRollbackCsv(s.files.get('/r/rb.csv')!)).toEqual([
      { jobPostingId: 'jp-1', projectId: 'v1-1', publicId: PUB(1), slug: null, whatsappUrl: WA },
    ]);
    expect(s.out()).toContain('rollback CSV: /r/rb.csv (1 linhas)');
  });

  it('recusa sobrescrever um CSV que já existe', async () => {
    const s = setup();
    s.files.set('/r/rb.csv', 'antigo');
    expect(await runReconcileCli(['--csv-out', '/r/rb.csv'], s.deps)).toBe(1);
    expect(s.out()).toContain('já existe');
    expect(s.files.get('/r/rb.csv')).toBe('antigo');
  });

  it('recusa se o CSV não ficou gravado', async () => {
    const s = setup();
    s.deps.fs.write = () => undefined;
    expect(await runReconcileCli(['--csv-out', '/r/rb.csv'], s.deps)).toBe(1);
    expect(s.out()).toContain('não foi gravado');
  });

  it('conexão que NÃO está read-only → recusa antes de ler qualquer coisa', async () => {
    const s = setup();
    s.db.readOnlySetting = 'off';
    expect(await runReconcileCli([], s.deps)).toBe(1);
    expect(s.out()).toContain('NÃO está read-only');
    expect(s.out()).not.toContain('DRY-RUN —');
  });

  it('escrita de teste que NÃO falha → recusa (read-only não provado)', async () => {
    const s = setup();
    s.db.probeFails = false;
    expect(await runReconcileCli([], s.deps)).toBe(1);
    expect(s.out()).toContain('read-only não provado');
  });

  it('wa.me mudou entre antes e depois → FALHA (rc 1)', async () => {
    const s = setup();
    let n = 0;
    s.db.query = new Proxy(s.db.query.bind(s.db), {
      apply: (target, _t, args: [string, unknown[]?]) =>
        args[0].includes('wa.me') ? Promise.resolve({ rows: [{ n: n++ }], rowCount: 1 }) : target(...args),
    });
    expect(await runReconcileCli([], s.deps)).toBe(1);
    expect(s.out()).toContain('FALHA: o dry-run alterou algo');
  });

  it('escrita HTTP na Talentum detectada → FALHA (rc 1)', async () => {
    const s = setup();
    s.deps.httpStats = () => ({ byMethod: { GET: 1, DELETE: 1 }, writes: 1 });
    expect(await runReconcileCli([], s.deps)).toBe(1);
    expect(s.out()).toContain('FALHA: o dry-run alterou algo');
  });

  it('lista os erros de detalhe por projectId e erro inesperado vira ERRO rc 1', async () => {
    const s = setup([{ projectId: 'v2-x', title: 'a', publicId: PUB(1), detailError: 'HTTP 500' }]);
    expect(await runReconcileCli([], s.deps)).toBe(0);
    expect(s.out()).toContain('erros de detalhe (projectId): 1 v2-x');

    const s2 = setup();
    s2.deps.openClient = async () => { throw new Error('sem credencial'); };
    expect(await runReconcileCli([], s2.deps)).toBe(1);
    expect(s2.out()).toContain('ERRO: sem credencial');
    expect(s2.db.ended).toBe(1);
  });
});

describe('runReconcileCli — --execute e --rollback', () => {
  it('execute: grava o CSV ANTES, aplica numa transação, wa.me cai, e o 2º run = 0 mudanças', async () => {
    const s = setup();
    expect(await runReconcileCli(['--execute', '--csv-out', '/r/rb.csv'], s.deps)).toBe(0);
    expect(s.openDb).toHaveBeenCalledWith(false);
    expect(s.out()).not.toContain('read-only');
    expect(s.out()).toContain('aplicadas: 1');
    expect(s.out()).toContain('wa.me antes: 1 · depois: 0');
    expect(s.db.rows[0]).toMatchObject({ talentum_project_id: 'v2-1', talentum_slug: 's1' });

    s.logs.length = 0;
    expect(await runReconcileCli(['--execute', '--csv-out', '/r/rb2.csv'], s.deps)).toBe(0);
    expect(s.out()).toContain('ligadas por publicId: 0 · por título: 0');
    expect(s.out()).toContain('aplicadas: 0');
    expect(s.out()).toContain('já corretas: 1');
  });

  it('execute com plano incompleto (detalhe falhou): recusa e não escreve nada', async () => {
    const s = setup([
      { projectId: 'v2-1', title: 'a', publicId: PUB(1) },
      { projectId: 'v2-x', title: 'b', publicId: PUB(2), detailError: 'HTTP 500' },
    ]);
    const before = s.db.snapshot();
    expect(await runReconcileCli(['--execute', '--csv-out', '/r/rb.csv'], s.deps)).toBe(1);
    expect(s.out()).toContain('plano está incompleto');
    expect(s.db.snapshot()).toBe(before);
    expect(s.files.size).toBe(0);
  });

  it('rollback: restaura o banco byte a byte a partir do CSV, sem tocar a Talentum', async () => {
    const s = setup();
    const before = s.db.snapshot();
    await runReconcileCli(['--execute', '--csv-out', '/r/rb.csv'], s.deps);
    expect(s.db.snapshot()).not.toBe(before);

    s.deps.openClient = async () => { throw new Error('rollback não pode abrir a Talentum'); };
    s.logs.length = 0;
    expect(await runReconcileCli(['--rollback', '/r/rb.csv'], s.deps)).toBe(0);
    expect(s.out()).toContain('ROLLBACK: 1 vagas restauradas de /r/rb.csv');
    expect(s.db.snapshot()).toBe(before);
    expect(s.openDb).toHaveBeenLastCalledWith(false);
  });

  it('rollback com CSV corrompido → ERRO rc 1', async () => {
    const s = setup();
    s.files.set('/r/ruim.csv', 'lixo\n');
    expect(await runReconcileCli(['--rollback', '/r/ruim.csv'], s.deps)).toBe(1);
    expect(s.out()).toContain('ERRO: rollback CSV: cabeçalho inesperado');
  });
});
