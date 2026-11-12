/**
 * Relógio civil — `fecha` das publicações (publishedAt é TIMESTAMPTZ) é o dia de Buenos Aires.
 * 2026-10-30T02:30:00Z = 23:30 BA de 29/10: o código antigo (`toISOString().split('T')[0]`) devolvia 2026-10-30.
 * Também fixa o instante-limite pedido: 2026-10-29T23:30:00Z (20:30 BA) → 2026-10-29.
 */
const mockFindByJobPosting = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue({ query: jest.fn() }) }) },
}));
jest.mock('@shared/database/requestDbSession', () => ({ currentDbContext: jest.fn() }));
jest.mock('@modules/identity', () => ({ resolveCountryScope: jest.fn(), CountryScopeError: class extends Error {} }));
jest.mock('@modules/identity/permissions', () => ({ cellsOfRequest: jest.fn().mockReturnValue(null) }));
jest.mock('@modules/audit', () => ({
  PublicationRepository: jest.fn().mockImplementation(() => ({
    countByChannelForJobPosting: jest.fn().mockResolvedValue([]),
    findByJobPosting: mockFindByJobPosting,
  })),
}));
jest.mock('../../../../../infrastructure/repositories/ClickUpCaseRepository', () => ({
  ClickUpCaseRepository: jest.fn().mockImplementation(() => ({ findByCaseNumber: jest.fn().mockResolvedValue(null) })),
}));
jest.mock('../../../infrastructure/EncuadreRepository', () => ({
  EncuadreRepository: jest.fn().mockImplementation(() => ({
    countCandidatesByJobPosting: jest.fn().mockResolvedValue(0),
    countInvitedAndAttended: jest.fn().mockResolvedValue({ invitados: 0, asistentes: 0 }),
    countByResultado: jest.fn().mockResolvedValue([]),
  })),
}));
jest.mock('../../../infrastructure/WorkerApplicationRepository', () => ({
  WorkerApplicationRepository: jest.fn().mockImplementation(() => ({ countByJobPosting: jest.fn().mockResolvedValue(0) })),
}));
jest.mock('../../../infrastructure/JobPostingARRepository', () => ({
  JobPostingARRepository: jest.fn().mockImplementation(() => ({ findByCaseNumber: jest.fn().mockResolvedValue({ id: 'jp1' }) })),
}));

import { AnalyticsDashboardController } from '../AnalyticsDashboardController';

async function fechas(publishedAt: Date | null): Promise<string[]> {
  mockFindByJobPosting.mockResolvedValue([{ publishedAt, channel: 'x', recruiterName: 'r', observations: null }]);
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  await new AnalyticsDashboardController().getCaseMetrics(
    { params: { caseNumber: '1' }, query: {} } as never,
    res as never,
  );
  return res.json.mock.calls[0][0].data.publicacionesList.map((p: { fecha: string }) => p.fecha);
}

describe('getCaseMetrics — fecha da publicação no dia de Buenos Aires', () => {
  it('2026-10-29T23:30:00Z → 2026-10-29', async () => {
    expect(await fechas(new Date('2026-10-29T23:30:00Z'))).toEqual(['2026-10-29']);
  });
  it('2026-10-30T02:30:00Z (23:30 BA) → 2026-10-29 (UTC daria 30)', async () => {
    expect(await fechas(new Date('2026-10-30T02:30:00Z'))).toEqual(['2026-10-29']);
  });
  it('sem publishedAt → "Sin fecha"', async () => {
    expect(await fechas(null)).toEqual(['Sin fecha']);
  });
});
