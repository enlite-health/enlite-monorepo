const mockQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue({ query: (...a: unknown[]) => mockQuery(...a) }) }) },
}));

import { TherapeuticProjectContactStatusRepository, toContactStatusViews } from '../TherapeuticProjectContactStatusRepository';

describe('TherapeuticProjectContactStatusRepository (spec 048)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('listByVersions: uma consulta para todas as versões, agrupa por versão e converte a data', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { version_id: 'v1', contact_kind: 'CARE_TEAM', status: 'PENDING', pending_since: '2026-09-08T10:00:00.000Z', marked_by_uid: 'u1' },
        { version_id: 'v1', contact_kind: 'EXTERNAL', status: 'NOT_NEEDED', pending_since: null, marked_by_uid: 'u2' },
        { version_id: 'v2', contact_kind: 'COVERAGE', status: 'PENDING', pending_since: new Date('2026-09-09T10:00:00.000Z'), marked_by_uid: 'u1' },
      ],
    });
    const map = await new TherapeuticProjectContactStatusRepository().listByVersions(['v1', 'v2']);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][1]).toEqual([['v1', 'v2']]);
    expect(map.get('v1')).toHaveLength(2);
    expect(map.get('v1')?.[0].pendingSince).toEqual(new Date('2026-09-08T10:00:00.000Z'));
    expect(map.get('v2')?.[0].kind).toBe('COVERAGE');
  });

  it('listByVersions com lista vazia não vai ao banco', async () => {
    expect((await new TherapeuticProjectContactStatusRepository().listByVersions([])).size).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('insertStatuses grava PENDING sem âncora como "agora" do Postgres e NOT_NEEDED sem âncora', async () => {
    const cli = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await new TherapeuticProjectContactStatusRepository().insertStatuses(cli as never, 'v', 'p', [
      { kind: 'RESPONSIBLE', status: 'PENDING', pendingSince: null, markedByUid: 'u' },
      { kind: 'EXTERNAL', status: 'NOT_NEEDED', pendingSince: null, markedByUid: 'u' },
    ]);
    expect(cli.query).toHaveBeenCalledTimes(2);
    expect(cli.query.mock.calls[0][0]).toContain("CASE WHEN $4::text = 'PENDING' THEN COALESCE($5::timestamptz, now()) END");
    expect(cli.query.mock.calls[1][1]).toEqual(['v', 'p', 'EXTERNAL', 'NOT_NEEDED', null, 'u']);
  });

  it('toContactStatusViews: ordem fixa, vencimento só para PENDING e nenhum uid', () => {
    const views = toContactStatusViews(
      [
        { kind: 'CARE_TEAM', status: 'PENDING', pendingSince: new Date('2026-10-09T02:30:00Z'), markedByUid: 'segredo' },
        { kind: 'RESPONSIBLE', status: 'NOT_NEEDED', pendingSince: null, markedByUid: 'segredo' },
      ],
      'AR',
    );
    expect(views).toEqual([
      { kind: 'RESPONSIBLE', status: 'NOT_NEEDED', pendingSince: null, deadlineDate: null },
      { kind: 'CARE_TEAM', status: 'PENDING', pendingSince: '2026-10-09T02:30:00.000Z', deadlineDate: '2026-10-23' },
    ]);
    expect(JSON.stringify(views)).not.toContain('segredo');
  });
});
