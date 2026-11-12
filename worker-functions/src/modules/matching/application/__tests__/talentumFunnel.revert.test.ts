/**
 * revertAutoRejectionOnPositiveVerdict — a REGRA DE DECISÃO (o SQL real é provado em tests/e2e/talentum-requalifica-rejeicao-automatica.test.ts).
 * Automática (última linha da trilha REJECTED sem changed_by + evento auto_not_qualified) reverte; humana nunca.
 */
import { revertAutoRejectionOnPositiveVerdict } from '../talentumFunnel';

type Hist = { new_value: string; changed_by: string | null } | null;

function fakeDb(hist: Hist, autoEvent: boolean) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  return {
    calls,
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (sql.includes('worker_job_application_stage_history')) return { rows: hist ? [hist] : [] };
      if (sql.includes("'auto_not_qualified'")) return { rows: autoEvent ? [{ '?column?': 1 }] : [] };
      return { rows: [] };
    }),
  };
}
const writes = (db: ReturnType<typeof fakeDb>) => db.calls.filter((c) => /^\s*(UPDATE|INSERT)/.test(c.sql));

describe('revertAutoRejectionOnPositiveVerdict', () => {
  it.each(['QUALIFIED', 'IN_DOUBT'])('rejeição automática + %s: reverte WJA, limpa encuadre e audita', async (stage) => {
    const db = fakeDb({ new_value: 'REJECTED', changed_by: null }, true);
    expect(await revertAutoRejectionOnPositiveVerdict(db, 'w', 'j', stage, 'REJECTED', 'p')).toBe(true);
    const w = writes(db);
    expect(w).toHaveLength(3);
    expect(w[0].sql).toContain('UPDATE worker_job_applications');
    expect(w[0].params).toEqual(['w', 'j', stage]);
    expect(w[1].sql).toContain("rejection_reason_category = 'TALENTUM_NOT_QUALIFIED'");
    expect(w[2].sql).toContain('funnel_stage.rejection_reverted');
  });

  it("changed_by '' (GUC vazio vazado do pool) também é automático", async () => {
    const db = fakeDb({ new_value: 'REJECTED', changed_by: '' }, true);
    expect(await revertAutoRejectionOnPositiveVerdict(db, 'w', 'j', 'QUALIFIED', 'REJECTED')).toBe(true);
  });

  it("changed_by 'system:<nome>' (rejeição por script) + evento auto_not_qualified: reverte", async () => {
    const db = fakeDb({ new_value: 'REJECTED', changed_by: 'system:reconciliar-talentum-sem-worker' }, true);
    expect(await revertAutoRejectionOnPositiveVerdict(db, 'w', 'j', 'QUALIFIED', 'REJECTED', 'p')).toBe(true);
    expect(writes(db)).toHaveLength(3);
  });

  it.each([
    ["system: SEM o evento auto_not_qualified (script que rejeitou por outro motivo)", { new_value: 'REJECTED', changed_by: 'system:outro-script' } as Hist, false],
    ["uid humano que apenas CONTÉM system:", { new_value: 'REJECTED', changed_by: 'uid-system:humano' } as Hist, true],
    ["'system' sem os dois pontos", { new_value: 'REJECTED', changed_by: 'system' } as Hist, true],
  ])('%s: NÃO reverte e não escreve nada', async (_n, hist, auto) => {
    const db = fakeDb(hist, auto);
    expect(await revertAutoRejectionOnPositiveVerdict(db, 'w', 'j', 'QUALIFIED', 'REJECTED')).toBe(false);
    expect(writes(db)).toEqual([]);
  });

  it.each([
    ['rejeição humana (changed_by preenchido)', { new_value: 'REJECTED', changed_by: 'uid-humano' } as Hist, true],
    ['humano moveu depois (última linha não é REJECTED)', { new_value: 'SELECTED', changed_by: 'uid-humano' } as Hist, true],
    ['sem trilha', null, true],
    ['sem evento auto_not_qualified', { new_value: 'REJECTED', changed_by: null } as Hist, false],
  ])('%s: NÃO reverte e não escreve nada', async (_n, hist, auto) => {
    const db = fakeDb(hist, auto);
    expect(await revertAutoRejectionOnPositiveVerdict(db, 'w', 'j', 'QUALIFIED', 'REJECTED')).toBe(false);
    expect(writes(db)).toEqual([]);
  });

  it.each([
    ['QUALIFIED', 'SELECTED'], ['QUALIFIED', null], ['NOT_QUALIFIED', 'REJECTED'], ['COMPLETED', 'REJECTED'],
  ])('%s sobre previousStage=%s: nem consulta o banco', async (stage, prev) => {
    const db = fakeDb({ new_value: 'REJECTED', changed_by: null }, true);
    expect(await revertAutoRejectionOnPositiveVerdict(db, 'w', 'j', stage, prev)).toBe(false);
    expect(db.query).not.toHaveBeenCalled();
  });
});
