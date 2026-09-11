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

  describe('getKind (lê o kind ATUAL — o controller decide o 403 do profissional direto antes de mexer na linha)', () => {
    it('devolve o kind quando a linha existe (para este paciente); null quando não existe ou é de outro paciente', async () => {
      const client = { query: jest.fn().mockResolvedValue({ rows: [{ kind: 'DIRECT_PROFESSIONAL' }] }) } as unknown as PoolClient;
      expect(await repo.getKind(PID, 'c1', client)).toBe('DIRECT_PROFESSIONAL');
      expect((client.query as jest.Mock).mock.calls[0]).toEqual([
        'SELECT kind FROM patient_coverage_emergency_contacts WHERE id = $2 AND patient_id = $1',
        [PID, 'c1'],
      ]);

      const semLinha = { query: jest.fn().mockResolvedValue({ rows: [] }) } as unknown as PoolClient;
      expect(await repo.getKind(PID, 'c1', semLinha)).toBeNull();

      // Sem executor: usa o pool do repositório.
      mockPoolQuery.mockResolvedValue({ rows: [{ kind: 'AMBULANCE' }] });
      expect(await repo.getKind(PID, 'c1')).toBe('AMBULANCE');
    });
  });

  describe('insertOne/updateOne/deactivate (escrita por linha — spec 018, PR-1, ADR-1)', () => {
    it('insertOne: INSERT com telefone CIFRADO, nome com trim, sort_order = MAX+1 (COALESCE 0 quando vazio) e autor carimbado', async () => {
      const client = { query: jest.fn().mockResolvedValue({ rows: [{ id: 'novo' }] }) } as unknown as PoolClient;
      const out = await repo.insertOne(PID, { kind: 'DIRECT_PROFESSIONAL', name: ' Dra. Pérez ', phone: ' +54 11 5555-0001 ' }, 'uid-staff', client);
      expect(out).toEqual({ id: 'novo' });
      const [sql, params] = (client.query as jest.Mock).mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('INSERT INTO patient_coverage_emergency_contacts (patient_id, kind, name, phone_encrypted, sort_order, created_by)');
      expect(sql).toContain('COALESCE((SELECT MAX(sort_order) + 1 FROM patient_coverage_emergency_contacts WHERE patient_id = $1), 0)');
      expect(params).toEqual([PID, 'DIRECT_PROFESSIONAL', 'Dra. Pérez', b64('+54 11 5555-0001'), 'uid-staff']);
      // 🔒 o telefone em claro NUNCA vai ao banco.
      expect(JSON.stringify(params)).not.toContain('5555-0001');
      expect(mockPoolQuery).not.toHaveBeenCalled(); // usou o client da transação, não o pool
    });

    it('updateOne: PATCH parcial — só as chaves presentes viram SET; telefone recifrado; ausente = não toca; sem chave nenhuma é no-op (sem query)', async () => {
      const client = { query: jest.fn().mockResolvedValue({ rows: [{ id: 'c1' }] }) } as unknown as PoolClient;
      const out = await repo.updateOne(PID, 'c1', { phone: ' 0800-2 ' }, client);
      expect(out).toEqual({ id: 'c1' });
      const [sql, params] = (client.query as jest.Mock).mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/SET phone_encrypted = \$3, updated_at = NOW\(\)/);
      expect(sql).toMatch(/WHERE id = \$2 AND patient_id = \$1/);
      expect(params).toEqual([PID, 'c1', b64('0800-2')]);

      (client.query as jest.Mock).mockClear();
      const noop = await repo.updateOne(PID, 'c1', {}, client);
      expect(noop).toEqual({ id: 'c1' });
      expect(client.query).not.toHaveBeenCalled();
    });

    it('updateOne: `kind` e `name` também viram SET, cada um no seu branch', async () => {
      const client = { query: jest.fn().mockResolvedValue({ rows: [{ id: 'c1' }] }) } as unknown as PoolClient;
      await repo.updateOne(PID, 'c1', { kind: 'EMERGENCY_CENTER', name: ' Central Nueva ' }, client);
      const [sql, params] = (client.query as jest.Mock).mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/SET kind = \$3, name = \$4, updated_at = NOW\(\)/);
      expect(params).toEqual([PID, 'c1', 'EMERGENCY_CENTER', 'Central Nueva']);
    });

    it('updateOne: linha de outro paciente, inexistente OU já desativada por outra aba (task 1.10 alt 2) → null (o controller decide 404); a query leva `AND active`', async () => {
      const client = { query: jest.fn().mockResolvedValue({ rows: [] }) } as unknown as PoolClient;
      expect(await repo.updateOne(PID, 'c1', { name: 'X' }, client)).toBeNull();
      const [sql] = (client.query as jest.Mock).mock.calls[0] as [string];
      expect(sql).toMatch(/WHERE id = \$2 AND patient_id = \$1 AND active/);
    });

    it('deactivate: SELECT … FOR UPDATE decide not_found/already_inactive/deactivated', async () => {
      const notFound = { query: jest.fn().mockResolvedValue({ rows: [] }) } as unknown as PoolClient;
      expect(await repo.deactivate(PID, 'c1', 'uid', notFound)).toEqual({ outcome: 'not_found' });
      expect(notFound.query).toHaveBeenCalledTimes(1); // não chegou a fazer o UPDATE

      const jaInativo = { query: jest.fn().mockResolvedValue({ rows: [{ id: 'c1', active: false }] }) } as unknown as PoolClient;
      expect(await repo.deactivate(PID, 'c1', 'uid', jaInativo)).toEqual({ outcome: 'already_inactive' });
      expect(jaInativo.query).toHaveBeenCalledTimes(1);

      const ativo = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [{ id: 'c1', active: true }] })
          .mockResolvedValueOnce({ rows: [] }),
      } as unknown as PoolClient;
      expect(await repo.deactivate(PID, 'c1', 'uid-staff', ativo)).toEqual({ outcome: 'deactivated', id: 'c1' });
      const [updSql, updParams] = (ativo.query as jest.Mock).mock.calls[1] as [string, unknown[]];
      expect(updSql).toMatch(/SET active = false, deactivated_at = NOW\(\), deactivated_by = \$3/);
      expect(updParams).toEqual([PID, 'c1', 'uid-staff']);
    });
  });

  describe('leitura', () => {
    const rows: CoverageEmergencyContactRow[] = [
      { id: 'c1', kind: 'EMERGENCY_CENTER', name: 'Central', phone_encrypted: 'enc-1', sort_order: 0 },
      { id: 'c2', kind: 'DIRECT_PROFESSIONAL', name: 'Dr. X', phone_encrypted: 'enc-2', sort_order: 1 },
    ];

    it('fetchRows: só o SELECT ordenado por sort_order, filtrando active (spec 018 PR-1) — 0 chamadas ao KMS', async () => {
      mockPoolQuery.mockResolvedValue({ rows });
      const out = await repo.fetchRows(PID);
      expect(sqlOf(0)[0]).toMatch(/SELECT id, kind, name, phone_encrypted, sort_order[\s\S]*WHERE patient_id = \$1 AND active[\s\S]*ORDER BY sort_order ASC, created_at ASC/);
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
