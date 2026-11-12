/**
 * BackfillTalentumPrescreeningId — CLI com banco e cliente Talentum DUBLÊS (nenhuma rede, nenhum canal real).
 * Ids fictícios, sem PII.
 */
import { runBackfillCli, type BackfillDb } from '../BackfillTalentumPrescreeningId';

type Row = Record<string, unknown>;

function makeDb(opts: { candidates: Row[]; taken?: string[]; readOnly?: boolean; probeFails?: boolean }) {
  const updates: unknown[][] = [];
  const db: BackfillDb & { opened?: boolean } = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      if (sql.startsWith('SHOW')) return { rows: [{ default_transaction_read_only: opts.readOnly === false ? 'off' : 'on' }] };
      if (sql.startsWith('CREATE TEMP')) {
        if (opts.probeFails === false) return { rows: [] };
        throw new Error('read-only transaction');
      }
      if (sql.includes('talentum_prescreening_id IS NULL') && sql.startsWith('SELECT')) return { rows: opts.candidates };
      if (sql.startsWith('SELECT')) return { rows: (opts.taken ?? []).map((t) => ({ talentum_prescreening_id: t })) };
      updates.push(params ?? []);
      return { rows: [], rowCount: 1 } as never;
    }),
    end: jest.fn(async () => undefined),
  };
  return { db, updates };
}

function makeDeps(db: BackfillDb, details: Record<string, unknown>, writes = 0) {
  const logs: string[] = [];
  const openDb = jest.fn(() => db);
  const deps = {
    openDb,
    openClient: async () => ({
      getPrescreening: jest.fn(async (pid: string) => {
        const d = details[pid];
        if (d instanceof Error) throw d;
        return d as never;
      }),
    }),
    httpStats: () => ({ byMethod: { GET: 3 }, writes }),
    log: (l: string) => logs.push(l),
  };
  return { deps, logs, openDb };
}

const cand = (id: string, pid: string) => ({ id, talentum_project_id: pid });
const ok = (pid: string, psc: string) => ({ projectId: pid, prescreeningId: psc });

describe('runBackfillCli', () => {
  it('sem modo, ou com os dois → uso (rc 2), sem abrir banco', async () => {
    const { db } = makeDb({ candidates: [] });
    const { deps, openDb } = makeDeps(db, {});
    expect(await runBackfillCli([], deps)).toBe(2);
    expect(await runBackfillCli(['--dry-run', '--apply'], deps)).toBe(2);
    expect(openDb).not.toHaveBeenCalled();
  });

  it('--dry-run: abre read-only, relata contagens (obtidos, não-200, colisões) e NÃO escreve', async () => {
    const { db, updates } = makeDb({
      candidates: [cand('jp1', 'pr1'), cand('jp2', 'pr2'), cand('jp3', 'pr3'), cand('jp4', 'pr4'), cand('jp5', 'pr5'), cand('jp6', 'pr6'), cand('jp7', 'pr7')],
      taken: ['psc-ja-usado'],
    });
    const { deps, logs, openDb } = makeDeps(db, {
      pr1: ok('pr1', 'psc1'),
      pr2: new Error('HTTP 404'),
      pr3: ok('pr3', 'psc-dup'),
      pr4: ok('pr4', 'psc-dup'),
      pr5: ok('pr5', 'psc-ja-usado'),
      pr6: { projectId: 'outro', prescreeningId: 'psc6' }, // projectId não confere → não obtido
      pr7: { projectId: 'pr7' }, // 200 sem _id → não obtido
    });
    expect(await runBackfillCli(['--dry-run'], deps)).toBe(0);
    expect(openDb).toHaveBeenCalledWith(true);
    expect(updates).toEqual([]);
    const out = logs.join('\n');
    expect(out).toContain('DRY-RUN — vagas candidatas=7 | obtidos=4 | não-200/sem _id=3 | colidiriam no índice=3');
    expect(out).toContain('colisões (job_posting_id): jp3,jp4,jp5');
    expect(out).toContain('não obtidos (job_posting_id): jp2,jp6,jp7');
    expect(out).toContain('escritas na Talentum: 0');
    expect(db.end).toHaveBeenCalled();
  });

  it('--dry-run recusa conexão que NÃO é read-only', async () => {
    const { db } = makeDb({ candidates: [], readOnly: false });
    await expect(runBackfillCli(['--dry-run'], makeDeps(db, {}).deps)).rejects.toThrow('NÃO está read-only');
    expect(db.end).toHaveBeenCalled();
  });

  it('--dry-run recusa quando a escrita de teste NÃO falha', async () => {
    const { db } = makeDb({ candidates: [], probeFails: false });
    await expect(runBackfillCli(['--dry-run'], makeDeps(db, {}).deps)).rejects.toThrow('read-only não provado');
  });

  it('--apply: grava só as sem colisão, só onde a coluna é NULL (UPDATE parametrizado)', async () => {
    const { db, updates } = makeDb({
      candidates: [cand('jp1', 'pr1'), cand('jp2', 'pr2'), cand('jp3', 'pr3'), cand('jp4', 'pr4')],
      taken: ['psc-ja-usado'],
    });
    const { deps, logs, openDb } = makeDeps(db, {
      pr1: ok('pr1', 'psc1'),
      pr2: ok('pr2', 'psc-dup'),
      pr3: ok('pr3', 'psc-dup'),
      pr4: ok('pr4', 'psc-ja-usado'),
    });
    expect(await runBackfillCli(['--apply'], deps)).toBe(0);
    expect(openDb).toHaveBeenCalledWith(false);
    expect(updates).toEqual([['psc1', 'jp1']]);
    const updateSql = String((db.query as jest.Mock).mock.calls.find((c) => String(c[0]).startsWith('UPDATE'))?.[0]);
    expect(updateSql).toContain('talentum_prescreening_id IS NULL');
    expect(logs.join('\n')).toContain('APPLY — vagas candidatas=4 | obtidos=4 | não-200/sem _id=0 | colidiriam no índice=3');
    expect(logs.join('\n')).toContain('gravadas: 1');
  });

  it('UPDATE sem rowCount conta 0 gravadas', async () => {
    const { db } = makeDb({ candidates: [cand('jp1', 'pr1')] });
    (db.query as jest.Mock).mockImplementation(async (sql: string) => {
      if (sql.startsWith('UPDATE')) return { rows: [] };
      if (sql.includes('IS NULL')) return { rows: [cand('jp1', 'pr1')] };
      return { rows: [] };
    });
    const { deps, logs } = makeDeps(db, { pr1: ok('pr1', 'psc1') });
    await runBackfillCli(['--apply'], deps);
    expect(logs.join('\n')).toContain('gravadas: 0');
  });

  it('rc 1 quando o contador acusa escrita na Talentum', async () => {
    const { db } = makeDb({ candidates: [] });
    expect(await runBackfillCli(['--apply'], makeDeps(db, {}, 1).deps)).toBe(1);
  });
});
