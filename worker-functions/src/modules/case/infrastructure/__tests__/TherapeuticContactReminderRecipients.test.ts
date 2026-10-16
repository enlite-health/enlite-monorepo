import { TherapeuticContactReminderRecipients } from '../TherapeuticContactReminderRecipients';
import type { ContactStatusRow } from '../TherapeuticProjectContactStatusRepository';

const pend = (kind: ContactStatusRow['kind'], by: string): ContactStatusRow => ({ kind, status: 'PENDING', pendingSince: new Date('2026-10-01T12:00:00Z'), markedByUid: by });

/** `users` vivos para a 1ª query (operadores) e o staff com células para a 2ª (dia 12). */
function db(vivos: string[], staff: Array<{ uid: string; cells: string[] | null }> = []) {
  const query = jest.fn(async (sql: string) => {
    if (sql.includes('iam.effective_permissions')) return { rows: staff };
    return { rows: vivos.map((uid) => ({ uid })) };
  });
  return { query } as never;
}

describe('TherapeuticContactReminderRecipients (spec 048)', () => {
  const svc = new TherapeuticContactReminderRecipients();

  it('dia 2/5: cada operador que marcou campo AINDA pendente recebe só os campos dele; não consulta células', async () => {
    const cli = db(['op1', 'op2']);
    const r = await svc.resolve(cli, [pend('CARE_TEAM', 'op1'), pend('RESPONSIBLE', 'op1'), pend('COVERAGE', 'op2')], false);
    expect(r).toEqual([
      { uid: 'op1', fields: ['RESPONSIBLE', 'CARE_TEAM'] },
      { uid: 'op2', fields: ['COVERAGE'] },
    ]);
    expect((cli as { query: jest.Mock }).query.mock.calls.every((c) => !String(c[0]).includes('effective_permissions'))).toBe(true);
  });

  it('operador inativo (ou fora do users) fica fora', async () => {
    expect(await svc.resolve(db(['op2']), [pend('RESPONSIBLE', 'op1'), pend('COVERAGE', 'op2')], false)).toEqual([{ uid: 'op2', fields: ['COVERAGE'] }]);
  });

  it('campo NOT_NEEDED (ou já resolvido) não gera destinatário', async () => {
    const nn: ContactStatusRow = { kind: 'EXTERNAL', status: 'NOT_NEEDED', pendingSince: null, markedByUid: 'op1' };
    expect(await svc.resolve(db(['op1']), [nn], true)).toEqual([]);
  });

  it('dia 12: soma quem tem `patient_therapeutic_project:incomplete_alert` — com TODOS os campos pendentes; quem não tem a célula não entra', async () => {
    const cli = db(['op1'], [
      { uid: 'master', cells: ['patient_therapeutic_project:incomplete_alert', 'x:y'] },
      { uid: 'outro', cells: ['patient_therapeutic_project:read'] },
      { uid: 'sem-grupo', cells: null },
    ]);
    const r = await svc.resolve(cli, [pend('RESPONSIBLE', 'op1'), pend('CARE_TEAM', 'op2-inativo')], true);
    expect(r).toEqual([
      { uid: 'op1', fields: ['RESPONSIBLE'] },
      { uid: 'master', fields: ['RESPONSIBLE', 'CARE_TEAM'] },
    ]);
  });

  it('operador que TAMBÉM é Master aparece uma vez, com todos os campos (dedup)', async () => {
    const cli = db(['m'], [{ uid: 'm', cells: ['patient_therapeutic_project:incomplete_alert'] }]);
    const r = await svc.resolve(cli, [pend('RESPONSIBLE', 'm'), pend('COVERAGE', 'outro')], true);
    expect(r).toEqual([{ uid: 'm', fields: ['RESPONSIBLE', 'COVERAGE'] }]);
  });

  it('a consulta por célula é só de staff ATIVO no tenant da Enlite', async () => {
    const cli = db([], []);
    await svc.resolve(cli, [pend('RESPONSIBLE', 'x')], true);
    const sql = String((cli as { query: jest.Mock }).query.mock.calls.find((c) => String(c[0]).includes('effective_permissions'))?.[0]);
    expect(sql).toContain("u.status = 'ACTIVE'");
  });
});
