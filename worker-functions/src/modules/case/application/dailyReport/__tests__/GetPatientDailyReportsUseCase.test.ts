import { GetPatientDailyReportsUseCase } from '../GetPatientDailyReportsUseCase';
import { canReadDailyReportNarrative, dailyReportTrailAction } from '../../dailyReportAccess';
import type { AdminReportRow, DailyReportAdminPort } from '../../ports/DailyReportAdminPort';

const ESPIA = 'NARRATIVA-ESPIA-092';
const NARRATIVE_CELL = 'daily_report_narrative:read';

const row = (over: Partial<AdminReportRow> = {}): AdminReportRow => ({
  id: 'r-1', workerId: 'w-1', onDate: '2026-11-16', ptiVersionId: 'v1', narrativeSource: 'TYPED',
  deviceSubmittedAt: new Date('2026-11-17T12:00:00.000Z'), receivedAt: new Date('2026-11-17T12:00:05.000Z'), appVersion: '1.0.0',
  guardEndsAt: new Date('2026-11-16T15:00:00.000Z'), narrative: ESPIA,
  answers: [
    { itemKind: 'objective', itemId: 'o-1', itemTitle: 'Objetivo', scaleCode: 'GEN', optionCode: '1', countValue: null, reasonCode: null, score: 1, immediateAlert: true },
    { itemKind: 'activity', itemId: 'a-1', itemTitle: 'Atividade', scaleCode: 'SN', optionCode: 'si', countValue: null, reasonCode: null, score: null, immediateAlert: false },
  ], ...over,
});

function port(rows: AdminReportRow[] | null) {
  const listForPatient = jest.fn(async (args: { withNarrative: boolean }) =>
    rows === null ? null : rows.map((r) => ({ ...r, narrative: args.withNarrative ? r.narrative : null })));
  return { port: { listForPatient } as DailyReportAdminPort, listForPatient };
}
const run = (p: DailyReportAdminPort, cells: readonly string[] | null) =>
  new GetPatientDailyReportsUseCase(p).execute({ patientId: 'p-1', from: null, to: null, cells });

describe('canReadDailyReportNarrative / dailyReportTrailAction — fail-closed', () => {
  it('só com a célula EXPLÍCITA; null (engine não decidiu), undefined e lista sem ela redigem', () => {
    expect(canReadDailyReportNarrative([NARRATIVE_CELL])).toBe(true);
    for (const cells of [null, undefined, [], ['daily_report:read']]) expect(canReadDailyReportNarrative(cells)).toBe(false);
    expect(dailyReportTrailAction([NARRATIVE_CELL])).toBe('read_daily_reports:narrative');
    expect(dailyReportTrailAction(null)).toBe('read_daily_reports');
  });
});

describe('GetPatientDailyReportsUseCase — redação por célula (CA-4)', () => {
  it('SEM daily_report_narrative:read: narrative null + narrativeRedacted true, e o adapter foi mandado NÃO ler o texto', async () => {
    const { port: p, listForPatient } = port([row()]);
    const out = await run(p, ['daily_report:read']);
    expect(listForPatient).toHaveBeenCalledWith(expect.objectContaining({ withNarrative: false }));
    expect(out?.items[0]).toMatchObject({ narrative: null, narrativeRedacted: true });
    expect(JSON.stringify(out)).not.toContain(ESPIA);
  });

  it('COM a célula: o texto vem e narrativeRedacted é false', async () => {
    const { port: p, listForPatient } = port([row()]);
    const out = await run(p, ['daily_report:read', NARRATIVE_CELL]);
    expect(listForPatient).toHaveBeenCalledWith(expect.objectContaining({ withNarrative: true }));
    expect(out?.items[0]).toMatchObject({ narrative: ESPIA, narrativeRedacted: false });
  });

  it('cells null (engine não decidiu): texto NÃO sai, mesmo que o adapter o devolvesse (defesa em profundidade)', async () => {
    const leaky: DailyReportAdminPort = { listForPatient: async () => [row()] };
    const out = await run(leaky, null);
    expect(out?.items[0]).toMatchObject({ narrative: null, narrativeRedacted: true });
    expect(JSON.stringify(out)).not.toContain(ESPIA);
  });

  it('estrutura: contagem de respostas, sinal imediato derivado e atraso derivado (enviado depois de fim + 24 h)', async () => {
    const noPrazo = await run(port([row()]).port, ['daily_report:read']);
    expect(noPrazo?.items[0]).toMatchObject({ answersCount: 2, immediateAlert: true, late: false, deviceSubmittedAt: '2026-11-17T12:00:00.000Z' });
    const atrasado = await run(port([row({ deviceSubmittedAt: new Date('2026-11-17T15:00:01.000Z') })]).port, ['daily_report:read']);
    expect(atrasado?.items[0].late).toBe(true);
    const semSinal = await run(port([row({ answers: [row().answers[1]] })]).port, ['daily_report:read']);
    expect(semSinal?.items[0]).toMatchObject({ immediateAlert: false, answersCount: 1 });
  });

  it('paciente inexistente/fora do escopo → null; paciente sem informe → lista vazia', async () => {
    expect(await run(port(null).port, [])).toBeNull();
    expect(await run(port([]).port, [])).toEqual({ items: [] });
  });
});
