/** `isLastManager` delega ao banco (`iam.is_last_manager`, 410) — fonte única com o trigger. */
const mockQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: mockQuery }) }) },
}));

import { AdminRepository } from '../AdminRepository';

describe('AdminRepository.isLastManager', () => {
  beforeEach(() => mockQuery.mockReset());

  it('pergunta ao banco pela função da 410, com o uid como parâmetro', async () => {
    mockQuery.mockResolvedValue({ rows: [{ last: true }] });
    expect(await new AdminRepository().isLastManager('uid-1')).toBe(true);
    expect(String(mockQuery.mock.calls[0][0])).toContain('iam.is_last_manager($1)');
    expect(mockQuery.mock.calls[0][1]).toEqual(['uid-1']);
  });

  it.each([
    ['false do banco', { rows: [{ last: false }] }],
    ['sem linha', { rows: [] }],
  ])('%s → false (só TRUE explícito trava)', async (_n, resposta) => {
    mockQuery.mockResolvedValue(resposta);
    expect(await new AdminRepository().isLastManager('uid-1')).toBe(false);
  });
});
