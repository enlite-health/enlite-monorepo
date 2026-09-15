import { patientExistsCheck } from '../patientExistsCheck';

describe('patientExistsCheck (achado item 5 da revisão do PR-4 — helper compartilhado)', () => {
  it('true quando a query devolve linha', async () => {
    const db = { query: jest.fn(async () => ({ rows: [{ x: 1 }] })) };
    await expect(patientExistsCheck(db as never, 'p1')).resolves.toBe(true);
    expect(db.query).toHaveBeenCalledWith('SELECT 1 FROM patients WHERE id = $1 AND deleted_at IS NULL', ['p1']);
  });

  it('false quando a query não devolve linha (inexistente ou soft-deletado)', async () => {
    const db = { query: jest.fn(async () => ({ rows: [] })) };
    await expect(patientExistsCheck(db as never, 'p1')).resolves.toBe(false);
  });
});
