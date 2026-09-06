/**
 * PatientResponsibleRepository — unit (pool e KMS mockados na fronteira; o
 * comportamento contra Postgres real está em tests/e2e/patient-responsibles-*.test.ts).
 * Molde: PatientClinicalRepository.test.ts.
 */
import type { PoolClient } from 'pg';

const mockPoolQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: mockPoolQuery }) }) },
}));
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
jest.mock('@shared/security/KMSEncryptionService', () => ({
  KMSEncryptionService: jest.fn().mockImplementation(() => ({
    encrypt: jest.fn(async (v: string | null) => (v ? b64(v) : null)),
    decrypt: jest.fn(),
  })),
}));

import { PatientResponsibleRepository } from '../PatientResponsibleRepository';
import type { PatientResponsibleInput } from '../../domain/PatientResponsible';

const PID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const row = (over: Partial<PatientResponsibleInput> = {}): PatientResponsibleInput => ({
  firstName: ' Ana ', lastName: ' Lima ', relationship: 'PARENT', phone: '+54911', email: 'a@b.co',
  documentType: 'DNI', documentNumber: '123', isPrimary: true, displayOrder: 1, source: 'web_form', ...over,
});
const sqlOf = (i: number): [string, unknown[]] => mockPoolQuery.mock.calls[i] as [string, unknown[]];

describe('PatientResponsibleRepository', () => {
  let repo: PatientResponsibleRepository;
  beforeEach(() => { mockPoolQuery.mockReset().mockResolvedValue({ rows: [] }); repo = new PatientResponsibleRepository(); });

  describe('replaceAll (drawer: a lista inteira)', () => {
    it('DELETE de todas as linhas + INSERT com PII cifrada, trim nos nomes e defaults', async () => {
      await repo.replaceAll(PID, [row(), row({ firstName: 'B', lastName: 'C', relationship: null, phone: null, email: null, documentType: null, documentNumber: null, isPrimary: false, displayOrder: 2, source: undefined })]);
      expect(sqlOf(0)[0]).toBe('DELETE FROM patient_responsibles WHERE patient_id = $1');
      const [insert, params] = sqlOf(1);
      expect(insert).toContain('INSERT INTO patient_responsibles');
      expect(params.slice(0, 11)).toEqual([PID, 'Ana', 'Lima', 'PARENT', b64('+54911'), b64('a@b.co'), b64('123'), 'DNI', true, 1, 'web_form']);
      expect(params.slice(11, 22)).toEqual([PID, 'B', 'C', null, null, null, null, null, false, 2, 'clickup']);
    });

    it('lista vazia ou só linhas sem nome → DELETE e nenhum INSERT', async () => {
      await repo.replaceAll(PID, [row({ firstName: ' ', lastName: '' })]);
      expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    });

    it('usa o client da transação quando fornecido', async () => {
      const client = { query: jest.fn().mockResolvedValue({ rows: [] }) } as unknown as PoolClient;
      await repo.replaceAll(PID, [], client);
      expect((client.query as jest.Mock)).toHaveBeenCalledTimes(1);
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });
  });

  describe('replaceBySource (sync do ClickUp: só as linhas daquela procedência)', () => {
    it('DELETE WHERE source = $2 + INSERT; linhas de outra procedência não são tocadas', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ exists: false }] });
      await repo.replaceBySource(PID, [row({ source: 'clickup' })], 'clickup');
      expect(sqlOf(0)[0]).toContain('is_primary = true AND source <> $2');
      expect(sqlOf(1)).toEqual(['DELETE FROM patient_responsibles WHERE patient_id = $1 AND source = $2', [PID, 'clickup']]);
      const [insert, params] = sqlOf(2);
      expect(insert).toContain('INSERT INTO patient_responsibles');
      expect(params[8]).toBe(true);
      expect(params[10]).toBe('clickup');
    });

    it('já existe titular de OUTRA procedência → as linhas entram como não-titular (índice único)', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ exists: true }] });
      await repo.replaceBySource(PID, [row({ source: 'clickup' })], 'clickup');
      expect(sqlOf(2)[1][8]).toBe(false);
    });

    it('lista vazia → só o DELETE da procedência', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ exists: false }] });
      await repo.replaceBySource(PID, [], 'clickup');
      expect(mockPoolQuery).toHaveBeenCalledTimes(2);
      expect(sqlOf(1)[0]).toContain('AND source = $2');
    });

    it('usa o client da transação quando fornecido', async () => {
      const client = { query: jest.fn().mockResolvedValue({ rows: [{ exists: false }] }) } as unknown as PoolClient;
      await repo.replaceBySource(PID, [row({ source: 'clickup' })], 'clickup', client);
      expect((client.query as jest.Mock)).toHaveBeenCalledTimes(3);
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });
  });

  describe('insertIfNoPrimary (backfill)', () => {
    it('já tem titular → skipped sem INSERT', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ exists: true }] });
      expect(await repo.insertIfNoPrimary(PID, row())).toEqual({ action: 'skipped' });
      expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    });
    it('sem titular → INSERT titular, display_order 1, e-mail null, source default legacy', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ exists: false }] });
      expect(await repo.insertIfNoPrimary(PID, row({ source: undefined, relationship: null, phone: null, documentNumber: null, documentType: null }))).toEqual({ action: 'inserted' });
      expect(sqlOf(1)[1]).toEqual([PID, 'Ana', 'Lima', null, null, null, null, null, true, 1, 'legacy-patients-column']);
    });
    it('usa o client da transação e respeita source informado', async () => {
      const client = { query: jest.fn().mockResolvedValueOnce({ rows: [{ exists: false }] }).mockResolvedValueOnce({ rows: [] }) } as unknown as PoolClient;
      await repo.insertIfNoPrimary(PID, row(), client);
      expect(((client.query as jest.Mock).mock.calls[1][1] as unknown[])[10]).toBe('web_form');
    });
  });

  it('findByPatientId devolve as linhas cifradas como estão', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 'r1' }] });
    expect(await repo.findByPatientId(PID)).toEqual([{ id: 'r1' }]);
    expect(sqlOf(0)[1]).toEqual([PID]);
  });
});
