/**
 * PatientCoverageEmergencyContactRepository — unit (pool e KMS na fronteira; o comportamento contra o
 * Postgres real, RLS e CASCADE estão em tests/e2e/patient-coverage-emergency-contacts.e2e.test.ts).
 * Molde: PatientResponsibleRepository.test.ts.
 */
import type { Pool, PoolClient } from 'pg';

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

import { PatientCoverageEmergencyContactRepository, type CoverageEmergencyContactRow } from '../PatientCoverageEmergencyContactRepository';

const PID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const sqlOf = (i: number): [string, unknown[]] => mockPoolQuery.mock.calls[i] as [string, unknown[]];

describe('PatientCoverageEmergencyContactRepository (417, D301)', () => {
  let repo: PatientCoverageEmergencyContactRepository;
  beforeEach(() => {
    mockPoolQuery.mockReset().mockResolvedValue({ rows: [] });
    mockDecrypt.mockClear();
    repo = new PatientCoverageEmergencyContactRepository();
  });

  describe('replaceAll (drawer: a lista inteira, mesma transação)', () => {
    it('DELETE de tudo + INSERT com telefone CIFRADO, nome com trim, sort_order pela ordem da tela e autor carimbado', async () => {
      const client = { query: jest.fn().mockResolvedValue({ rows: [] }) } as unknown as PoolClient;
      await repo.replaceAll(PID, [
        { kind: 'DIRECT_PROFESSIONAL', name: ' Dra. Pérez ', phone: ' +54 11 5555-0001 ' },
        { kind: 'AMBULANCE', name: 'Ambulancia OSDE', phone: '0800-1' },
      ], 'uid-staff', client);
      const calls = (client.query as jest.Mock).mock.calls as [string, unknown[]][];
      expect(calls[0][0]).toBe('DELETE FROM patient_coverage_emergency_contacts WHERE patient_id = $1');
      expect(calls[0][1]).toEqual([PID]);
      expect(calls[1][0]).toContain('INSERT INTO patient_coverage_emergency_contacts (patient_id, kind, name, phone_encrypted, sort_order, created_by)');
      expect(calls[1][0]).toContain('($1, $2, $3, $4, $5, $6), ($7, $8, $9, $10, $11, $12)');
      expect(calls[1][1]).toEqual([
        PID, 'DIRECT_PROFESSIONAL', 'Dra. Pérez', b64('+54 11 5555-0001'), 0, 'uid-staff',
        PID, 'AMBULANCE', 'Ambulancia OSDE', b64('0800-1'), 1, 'uid-staff',
      ]);
      // 🔒 o telefone em claro NUNCA vai ao banco.
      expect(JSON.stringify(calls[1][1])).not.toContain('5555-0001');
      expect(mockPoolQuery).not.toHaveBeenCalled(); // usou o client da transação, não o pool
    });

    it('lista vazia (ou só linhas sem nome/telefone): só o DELETE — a segunda trava depois do zod', async () => {
      await repo.replaceAll(PID, [], 'uid');
      expect(mockPoolQuery).toHaveBeenCalledTimes(1);
      expect(sqlOf(0)[0]).toMatch(/^DELETE/);
      mockPoolQuery.mockClear();
      await repo.replaceAll(PID, [{ kind: 'AMBULANCE', name: '   ', phone: '1' }, { kind: 'AMBULANCE', name: 'X', phone: '  ' }], 'uid');
      expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    });
  });

  describe('leitura', () => {
    const rows: CoverageEmergencyContactRow[] = [
      { id: 'c1', kind: 'EMERGENCY_CENTER', name: 'Central', phone_encrypted: 'enc-1', sort_order: 0 },
      { id: 'c2', kind: 'DIRECT_PROFESSIONAL', name: 'Dr. X', phone_encrypted: 'enc-2', sort_order: 1 },
    ];

    it('fetchRows: só o SELECT ordenado por sort_order — 0 chamadas ao KMS', async () => {
      mockPoolQuery.mockResolvedValue({ rows });
      const out = await repo.fetchRows(PID);
      expect(sqlOf(0)[0]).toMatch(/SELECT id, kind, name, phone_encrypted, sort_order[\s\S]*ORDER BY sort_order ASC, created_at ASC/);
      expect(sqlOf(0)[1]).toEqual([PID]);
      expect(out).toBe(rows);
      expect(mockDecrypt).not.toHaveBeenCalled();
    });

    it('decryptRows: decifra CADA telefone e mapeia para o detalhe; ciphertext vazio vira ""', async () => {
      const out = await repo.decryptRows([...rows, { id: 'c3', kind: 'AMBULANCE' as const, name: 'A', phone_encrypted: '', sort_order: 2 }]);
      expect(mockDecrypt.mock.calls.map((c) => c[0])).toEqual(['enc-1', 'enc-2', '']);
      expect(out).toEqual([
        { id: 'c1', kind: 'EMERGENCY_CENTER', name: 'Central', phone: 'dec(enc-1)', sortOrder: 0 },
        { id: 'c2', kind: 'DIRECT_PROFESSIONAL', name: 'Dr. X', phone: 'dec(enc-2)', sortOrder: 1 },
        { id: 'c3', kind: 'AMBULANCE', name: 'A', phone: '', sortOrder: 2 },
      ]);
    });

    it('listForPatient = fetchRows + decryptRows, no executor que receber', async () => {
      const executor = { query: jest.fn().mockResolvedValue({ rows: [rows[0]] }) } as unknown as Pool;
      const out = await repo.listForPatient(PID, executor);
      expect((executor.query as jest.Mock)).toHaveBeenCalledTimes(1);
      expect(mockPoolQuery).not.toHaveBeenCalled();
      expect(out).toEqual([{ id: 'c1', kind: 'EMERGENCY_CENTER', name: 'Central', phone: 'dec(enc-1)', sortOrder: 0 }]);
      // Sem executor: o pool do repositório.
      mockPoolQuery.mockResolvedValue({ rows: [rows[1]] });
      expect(await repo.listForPatient(PID)).toEqual([{ id: 'c2', kind: 'DIRECT_PROFESSIONAL', name: 'Dr. X', phone: 'dec(enc-2)', sortOrder: 1 }]);
      expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    });
  });
});
