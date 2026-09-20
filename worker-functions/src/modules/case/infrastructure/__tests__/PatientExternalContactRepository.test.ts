/**
 * PatientExternalContactRepository — unit (pool e KMS na fronteira; comportamento contra o
 * Postgres real, RLS e CASCADE em tests/e2e/patient-external-contacts.e2e.test.ts).
 * Molde: PatientCoverageEmergencyContactRepository.test.ts.
 */
import type { PoolClient } from 'pg';

const mockPoolQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: mockPoolQuery }) }) },
}));
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const mockDecrypt = jest.fn(async (v: string | null) => (v ? `dec(${v})` : null));
jest.mock('@shared/security/KMSEncryptionService', () => ({
  KMSEncryptionService: jest.fn().mockImplementation(() => ({
    encrypt: jest.fn(async (v: string | null) => (v ? b64(v) : null)),
    decrypt: (v: string | null) => mockDecrypt(v),
  })),
}));

import { PatientExternalContactRepository, type ExternalContactRow } from '../PatientExternalContactRepository';
import { EmergencyContactRequiresPhoneError } from '../EmergencyContactRequiresPhoneError';

const PID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('PatientExternalContactRepository (422, spec 018 PR-2)', () => {
  let repo: PatientExternalContactRepository;
  beforeEach(() => {
    mockPoolQuery.mockReset().mockResolvedValue({ rows: [] });
    mockDecrypt.mockClear();
    repo = new PatientExternalContactRepository();
  });

  describe('fetchRows / listForPatient / decryptRows', () => {
    it('fetchRows: só o SELECT filtrando active, ordenado por sort_order — 0 chamadas ao KMS', async () => {
      const rows: ExternalContactRow[] = [{ id: 'c1', relation: 'TEACHER', name: 'Prof. X', phone_encrypted: 'enc-1', sort_order: 0 }];
      mockPoolQuery.mockResolvedValue({ rows });
      const out = await repo.fetchRows(PID);
      const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/SELECT id, relation, name, phone_encrypted, sort_order[\s\S]*WHERE patient_id = \$1 AND active[\s\S]*ORDER BY sort_order ASC, created_at ASC/);
      expect(params).toEqual([PID]);
      expect(out).toBe(rows);
      expect(mockDecrypt).not.toHaveBeenCalled();
    });

    it('decryptRows: telefone ausente (NULL) vira null SEM chamar o KMS; telefone presente decifra', async () => {
      const rows: ExternalContactRow[] = [
        { id: 'c1', relation: 'NEIGHBOR', name: 'Vecina', phone_encrypted: null, sort_order: 0 },
        { id: 'c2', relation: 'TEACHER', name: 'Prof.', phone_encrypted: 'enc-2', sort_order: 1 },
      ];
      const out = await repo.decryptRows(rows);
      expect(out).toEqual([
        { id: 'c1', relation: 'NEIGHBOR', name: 'Vecina', phone: null, active: true },
        { id: 'c2', relation: 'TEACHER', name: 'Prof.', phone: 'dec(enc-2)', active: true },
      ]);
      expect(mockDecrypt).toHaveBeenCalledTimes(1);
      expect(mockDecrypt).toHaveBeenCalledWith('enc-2');
    });

    it('listForPatient: fetchRows + decryptRows compostos', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [{ id: 'c1', relation: 'OTHER', name: 'X', phone_encrypted: null, sort_order: 0 }] });
      expect(await repo.listForPatient(PID)).toEqual([{ id: 'c1', relation: 'OTHER', name: 'X', phone: null, active: true }]);
    });
  });

  describe('insertOne', () => {
    it('sem telefone: phone_encrypted vai NULL (D-A #3: sem telefone não pode ser marcado depois, mas pode existir)', async () => {
      const client = { query: jest.fn().mockResolvedValue({ rows: [{ id: 'novo' }] }) } as unknown as PoolClient;
      const out = await repo.insertOne(PID, { relation: 'NEIGHBOR', name: 'Vecina', phone: null }, 'uid-staff', client);
      expect(out).toEqual({ id: 'novo' });
      const [sql, params] = (client.query as jest.Mock).mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('INSERT INTO patient_external_contacts (patient_id, relation, name, phone_encrypted, sort_order, created_by)');
      expect(params).toEqual([PID, 'NEIGHBOR', 'Vecina', null, 'uid-staff']);
    });

    it('com telefone: cifra antes de gravar — texto claro NUNCA vai ao banco', async () => {
      const client = { query: jest.fn().mockResolvedValue({ rows: [{ id: 'novo' }] }) } as unknown as PoolClient;
      const out = await repo.insertOne(PID, { relation: 'TEACHER', name: 'Prof. Gómez', phone: '11-5555-0002' }, 'uid-staff', client);
      expect(out).toEqual({ id: 'novo' });
      const [, params] = (client.query as jest.Mock).mock.calls[0] as [string, unknown[]];
      expect(params).toEqual([PID, 'TEACHER', 'Prof. Gómez', b64('11-5555-0002'), 'uid-staff']);
      expect(JSON.stringify(params)).not.toContain('5555-0002');
    });
  });

  describe('updateOne', () => {
    it('PATCH vazio ({}) é no-op mas confere posse/existência/active (SELECT, nunca UPDATE)', async () => {
      const client = { query: jest.fn().mockResolvedValue({ rows: [{ id: 'c1' }] }) } as unknown as PoolClient;
      const out = await repo.updateOne(PID, 'c1', {}, client);
      expect(out).toEqual({ id: 'c1' });
      const [sql] = (client.query as jest.Mock).mock.calls[0] as [string];
      expect(sql).toMatch(/^SELECT id FROM patient_external_contacts WHERE id = \$2 AND patient_id = \$1 AND active/);
      expect(sql).not.toMatch(/UPDATE/);
    });

    it('PATCH parcial — só as chaves presentes viram SET; phone: null apaga', async () => {
      const client = { query: jest.fn().mockResolvedValue({ rows: [{ id: 'c1' }] }) } as unknown as PoolClient;
      await repo.updateOne(PID, 'c1', { phone: null }, client);
      const [sql, params] = (client.query as jest.Mock).mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/SET phone_encrypted = \$3, updated_at = NOW\(\)/);
      expect(params).toEqual([PID, 'c1', null]);
    });

    it('linha de OUTRO paciente/inexistente/desativada → null (404 no controller)', async () => {
      const client = { query: jest.fn().mockResolvedValue({ rows: [] }) } as unknown as PoolClient;
      expect(await repo.updateOne(PID, 'c1', { name: 'X' }, client)).toBeNull();
    });

    it('PATCH vazio ({}) em linha inexistente → null (o SELECT do no-op não acha a linha)', async () => {
      const client = { query: jest.fn().mockResolvedValue({ rows: [] }) } as unknown as PoolClient;
      expect(await repo.updateOne(PID, 'c1', {}, client)).toBeNull();
    });

    it('PATCH só `relation`: name/phone intactos', async () => {
      const client = { query: jest.fn().mockResolvedValue({ rows: [{ id: 'c1' }] }) } as unknown as PoolClient;
      await repo.updateOne(PID, 'c1', { relation: 'NEIGHBOR' }, client);
      const [sql, params] = (client.query as jest.Mock).mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/SET relation = \$3, updated_at = NOW\(\)/);
      expect(params).toEqual([PID, 'c1', 'NEIGHBOR']);
    });

    it('PATCH `phone` com valor: cifra antes de gravar (não o `null` de apagar)', async () => {
      const client = { query: jest.fn().mockResolvedValue({ rows: [{ id: 'c1' }] }) } as unknown as PoolClient;
      await repo.updateOne(PID, 'c1', { phone: '11-9999-0000' }, client);
      const [, params] = (client.query as jest.Mock).mock.calls[0] as [string, unknown[]];
      expect(params).toEqual([PID, 'c1', b64('11-9999-0000')]);
    });

    it('23514 do trigger de bloqueio (linha marcada de emergência sem telefone) vira EmergencyContactRequiresPhoneError', async () => {
      const client = { query: jest.fn().mockRejectedValue({ code: '23514' }) } as unknown as PoolClient;
      await expect(repo.updateOne(PID, 'c1', { phone: null }, client)).rejects.toBeInstanceOf(EmergencyContactRequiresPhoneError);
    });

    it('outro erro de banco passa intocado (não vira EmergencyContactRequiresPhoneError)', async () => {
      const outro = new Error('conexão perdida');
      const client = { query: jest.fn().mockRejectedValue(outro) } as unknown as PoolClient;
      await expect(repo.updateOne(PID, 'c1', { name: 'X' }, client)).rejects.toBe(outro);
    });
  });

  describe('deactivate', () => {
    it('delega para deactivateRow (nunca DELETE)', async () => {
      const client = { query: jest.fn().mockResolvedValueOnce({ rows: [{ id: 'c1', active: true }] }).mockResolvedValueOnce({ rows: [{ marked: false }] }).mockResolvedValueOnce({ rows: [] }) } as unknown as PoolClient;
      const out = await repo.deactivate(PID, 'c1', 'uid-staff', client);
      expect(out).toEqual({ outcome: 'deactivated', id: 'c1', emergencyMarkCleared: false });
      const calls = (client.query as jest.Mock).mock.calls;
      expect(calls.some(([sql]: [string]) => /UPDATE patient_external_contacts SET active = false/.test(sql))).toBe(true);
      expect(calls.some(([sql]: [string]) => /DELETE/.test(sql))).toBe(false);
    });

    it('wasMarked cai em false (`?? false`) quando a checagem da marca não acha o paciente (0 linhas)', async () => {
      const client = { query: jest.fn().mockResolvedValueOnce({ rows: [{ id: 'c1', active: true }] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }) } as unknown as PoolClient;
      const out = await repo.deactivate(PID, 'c1', 'uid-staff', client);
      expect(out).toEqual({ outcome: 'deactivated', id: 'c1', emergencyMarkCleared: false });
    });
  });
});
