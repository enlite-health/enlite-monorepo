/**
 * PatientProfessionalRepository — unit (pool e KMS na fronteira; o comportamento contra o
 * Postgres real, RLS e CHECK de specialty estão em tests/e2e/patient-care-team-api.e2e.test.ts).
 * Molde: PatientCoverageEmergencyContactRepository.test.ts.
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

import { PatientProfessionalRepository, type PatientProfessionalRow } from '../PatientProfessionalRepository';

const PID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const sqlOf = (i: number): [string, unknown[]] => mockPoolQuery.mock.calls[i] as [string, unknown[]];

describe('PatientProfessionalRepository (427, spec 018 PR-5)', () => {
  let repo: PatientProfessionalRepository;
  beforeEach(() => {
    mockPoolQuery.mockReset().mockResolvedValue({ rows: [] });
    mockDecrypt.mockClear();
    repo = new PatientProfessionalRepository();
  });

  describe('insertOne (sempre admin_manual — lex C9)', () => {
    it('telefone/e-mail CIFRADOS, nome com trim, display_order = MAX+1, source fixo, autor carimbado', async () => {
      const client = { query: jest.fn().mockResolvedValue({ rows: [{ id: 'novo' }] }) } as unknown as PoolClient;
      const out = await repo.insertOne(PID, { name: ' Dra. Pérez ', phone: ' +54 11 5555-0001 ', email: ' dra@x.com ', specialty: 'PHYSICIAN' }, 'uid-staff', client);
      expect(out).toEqual({ id: 'novo' });
      const [sql, params] = (client.query as jest.Mock).mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('INSERT INTO patient_professionals');
      expect(sql).toContain("'admin_manual'");
      expect(sql).toContain('(SELECT COALESCE(MAX(display_order), 0) + 1 FROM patient_professionals WHERE patient_id = $1)');
      expect(params).toEqual([PID, 'Dra. Pérez', b64('+54 11 5555-0001'), b64('dra@x.com'), 'PHYSICIAN', 'uid-staff']);
      // 🔒 telefone/e-mail em claro NUNCA vão ao banco.
      expect(JSON.stringify(params)).not.toContain('5555-0001');
      expect(JSON.stringify(params)).not.toContain('dra@x.com');
      expect(mockPoolQuery).not.toHaveBeenCalled(); // usou o client da transação, não o pool
    });

    it('phone/email ausentes ou vazios viram null cifrado (sem quebrar em trim de undefined)', async () => {
      const client = { query: jest.fn().mockResolvedValue({ rows: [{ id: 'novo' }] }) } as unknown as PoolClient;
      await repo.insertOne(PID, { name: 'Dr. X', phone: null, email: null, specialty: null }, 'uid', client);
      const [, params] = (client.query as jest.Mock).mock.calls[0] as [string, unknown[]];
      expect(params).toEqual([PID, 'Dr. X', null, null, null, 'uid']);
    });
  });

  describe('updateOne (PATCH parcial — RFC 7396)', () => {
    it('só as chaves presentes viram SET; specialty também é um branch próprio', async () => {
      const client = { query: jest.fn().mockResolvedValue({ rows: [{ id: 'p1' }] }) } as unknown as PoolClient;
      const out = await repo.updateOne(PID, 'p1', { specialty: 'NURSE' }, client);
      expect(out).toEqual({ id: 'p1' });
      const [sql, params] = (client.query as jest.Mock).mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/SET specialty = \$3, updated_at = NOW\(\)/);
      expect(sql).toMatch(/WHERE id = \$2 AND patient_id = \$1 AND active/);
      expect(params).toEqual([PID, 'p1', 'NURSE']);
    });

    it('name/phone/email cada um no seu branch; phone/email recifrados', async () => {
      const client = { query: jest.fn().mockResolvedValue({ rows: [{ id: 'p1' }] }) } as unknown as PoolClient;
      await repo.updateOne(PID, 'p1', { name: ' Novo Nome ', phone: ' 123 ', email: ' a@b.com ' }, client);
      const [sql, params] = (client.query as jest.Mock).mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/SET name = \$3, phone_encrypted = \$4, email_encrypted = \$5, updated_at = NOW\(\)/);
      expect(params).toEqual([PID, 'p1', 'Novo Nome', b64('123'), b64('a@b.com')]);
    });

    it('phone/email explicitamente null (apaga o contato) — ramo falsy do `?.trim() || null`', async () => {
      const client = { query: jest.fn().mockResolvedValue({ rows: [{ id: 'p1' }] }) } as unknown as PoolClient;
      await repo.updateOne(PID, 'p1', { phone: null, email: null }, client);
      const [, params] = (client.query as jest.Mock).mock.calls[0] as [string, unknown[]];
      expect(params).toEqual([PID, 'p1', null, null]);
    });

    it('PATCH vazio ({}) é no-op mas confere posse/existência/active — SELECT, nunca UPDATE', async () => {
      const client = { query: jest.fn().mockResolvedValue({ rows: [{ id: 'p1' }] }) } as unknown as PoolClient;
      const out = await repo.updateOne(PID, 'p1', {}, client);
      expect(out).toEqual({ id: 'p1' });
      const [sql, params] = (client.query as jest.Mock).mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/^SELECT id FROM patient_professionals WHERE id = \$2 AND patient_id = \$1 AND active/);
      expect(sql).not.toMatch(/UPDATE/);
      expect(params).toEqual([PID, 'p1']);
    });

    it('PATCH vazio em linha de outro paciente/inexistente/desativada → null (404 no controller)', async () => {
      const client = { query: jest.fn().mockResolvedValue({ rows: [] }) } as unknown as PoolClient;
      expect(await repo.updateOne('outro-paciente', 'p1', {}, client)).toBeNull();
    });

    it('linha de outro paciente, inexistente ou já desativada por outra aba → null; a query leva AND active', async () => {
      const client = { query: jest.fn().mockResolvedValue({ rows: [] }) } as unknown as PoolClient;
      expect(await repo.updateOne(PID, 'p1', { name: 'X' }, client)).toBeNull();
      const [sql] = (client.query as jest.Mock).mock.calls[0] as [string];
      expect(sql).toMatch(/WHERE id = \$2 AND patient_id = \$1 AND active/);
    });
  });

  describe('deactivate (nunca DELETE — C8)', () => {
    it('SELECT … FOR UPDATE decide not_found/already_inactive/deactivated', async () => {
      const notFound = { query: jest.fn().mockResolvedValue({ rows: [] }) } as unknown as PoolClient;
      expect(await repo.deactivate(PID, 'p1', 'uid', notFound)).toEqual({ outcome: 'not_found' });
      expect(notFound.query).toHaveBeenCalledTimes(1);

      const jaInativo = { query: jest.fn().mockResolvedValue({ rows: [{ id: 'p1', active: false }] }) } as unknown as PoolClient;
      expect(await repo.deactivate(PID, 'p1', 'uid', jaInativo)).toEqual({ outcome: 'already_inactive' });

      const ativo = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [{ id: 'p1', active: true }] })
          .mockResolvedValueOnce({ rows: [] }),
      } as unknown as PoolClient;
      expect(await repo.deactivate(PID, 'p1', 'uid-staff', ativo)).toEqual({ outcome: 'deactivated', id: 'p1' });
      const [updSql, updParams] = (ativo.query as jest.Mock).mock.calls[1] as [string, unknown[]];
      expect(updSql).toMatch(/SET active = false, deactivated_at = NOW\(\), deactivated_by = \$3/);
      expect(updParams).toEqual([PID, 'p1', 'uid-staff']);
    });
  });

  describe('leitura', () => {
    const rows: PatientProfessionalRow[] = [
      { id: 'p1', name: 'Dr. X', phone_encrypted: 'enc-1', email_encrypted: 'enc-mail-1', specialty: 'PHYSICIAN', display_order: 0, is_team: false },
      { id: 'p2', name: 'Equipo', phone_encrypted: null, email_encrypted: null, specialty: null, display_order: 1, is_team: true },
    ];

    it('fetchRows: só o SELECT ordenado, filtrando active — 0 chamadas ao KMS (lex C2)', async () => {
      mockPoolQuery.mockResolvedValue({ rows });
      const out = await repo.fetchRows(PID);
      expect(sqlOf(0)[0]).toMatch(/SELECT id, name, phone_encrypted, email_encrypted, specialty, display_order, is_team[\s\S]*WHERE patient_id = \$1 AND active[\s\S]*ORDER BY display_order ASC, created_at ASC/);
      expect(sqlOf(0)[1]).toEqual([PID]);
      expect(out).toBe(rows);
      expect(mockDecrypt).not.toHaveBeenCalled();
    });

    it('decryptRows: decifra telefone E e-mail de cada linha; null vira null (nunca "")', async () => {
      const out = await repo.decryptRows(rows);
      expect(mockDecrypt.mock.calls.map((c) => c[0])).toEqual(['enc-1', 'enc-mail-1', null, null]);
      expect(out).toEqual([
        { id: 'p1', name: 'Dr. X', phone: 'dec(enc-1)', email: 'dec(enc-mail-1)', specialty: 'PHYSICIAN', displayOrder: 0, isTeam: false },
        { id: 'p2', name: 'Equipo', phone: null, email: null, specialty: null, displayOrder: 1, isTeam: true },
      ]);
    });

    it('listForPatient = fetchRows + decryptRows, no executor que receber (ou no pool, sem executor)', async () => {
      const executor = { query: jest.fn().mockResolvedValue({ rows: [rows[0]] }) } as unknown as Pool;
      const out = await repo.listForPatient(PID, executor);
      expect((executor.query as jest.Mock)).toHaveBeenCalledTimes(1);
      expect(mockPoolQuery).not.toHaveBeenCalled();
      expect(out).toEqual([{ id: 'p1', name: 'Dr. X', phone: 'dec(enc-1)', email: 'dec(enc-mail-1)', specialty: 'PHYSICIAN', displayOrder: 0, isTeam: false }]);
      mockPoolQuery.mockResolvedValue({ rows: [rows[1]] });
      expect(await repo.listForPatient(PID)).toEqual([{ id: 'p2', name: 'Equipo', phone: null, email: null, specialty: null, displayOrder: 1, isTeam: true }]);
      expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    });
  });
});
