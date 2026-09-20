/**
 * PatientEmergencyMarkRepository — `patients.emergency_*` (migration 423, spec 018 PR-2, D-A).
 * Unit (pool na fronteira); o trigger de validade real (23514) é a e2e
 * `tests/e2e/patient-emergency-mark-db.e2e.test.ts`.
 */
import type { PoolClient } from 'pg';
import { PatientEmergencyMarkRepository } from '../PatientEmergencyMarkRepository';

const PID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const RID = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';
const XID = 'cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('PatientEmergencyMarkRepository (423, spec 018 PR-2)', () => {
  let repo: PatientEmergencyMarkRepository;
  const poolQuery = jest.fn();
  beforeEach(() => { poolQuery.mockReset().mockResolvedValue({ rows: [] }); repo = new PatientEmergencyMarkRepository({ query: poolQuery } as never); });

  describe('getRef', () => {
    it('sem executor explícito: usa o pool do repositório (default do construtor)', async () => {
      poolQuery.mockResolvedValue({ rows: [{ emergency_responsible_id: RID, emergency_external_contact_id: null }] });
      expect(await repo.getRef(PID)).toEqual({ kind: 'RESPONSIBLE', id: RID });
      expect(poolQuery).toHaveBeenCalledWith(expect.stringContaining('FROM patients WHERE id = $1'), [PID]);
    });

    it('devolve null quando o paciente não existe ou as duas colunas são NULL', async () => {
      const executor = { query: jest.fn().mockResolvedValue({ rows: [{ emergency_responsible_id: null, emergency_external_contact_id: null }] }) };
      expect(await repo.getRef(PID, executor as never)).toBeNull();
    });

    it('prioriza responsável quando (por invariante do banco) só um está preenchido', async () => {
      const executor = { query: jest.fn().mockResolvedValue({ rows: [{ emergency_responsible_id: RID, emergency_external_contact_id: null }] }) };
      expect(await repo.getRef(PID, executor as never)).toEqual({ kind: 'RESPONSIBLE', id: RID });
    });

    it('devolve o externo quando é ele que está marcado', async () => {
      const executor = { query: jest.fn().mockResolvedValue({ rows: [{ emergency_responsible_id: null, emergency_external_contact_id: XID }] }) };
      expect(await repo.getRef(PID, executor as never)).toEqual({ kind: 'EXTERNAL', id: XID });
    });

    it('devolve null quando não há linha para o paciente', async () => {
      const executor = { query: jest.fn().mockResolvedValue({ rows: [] }) };
      expect(await repo.getRef(PID, executor as never)).toBeNull();
    });
  });

  describe('mark', () => {
    it('not_found quando a linha não existe, é de outro paciente ou está inativa', async () => {
      const client = { query: jest.fn().mockResolvedValue({ rows: [] }) } as unknown as PoolClient;
      expect(await repo.mark(PID, 'RESPONSIBLE', RID, client)).toEqual({ outcome: 'not_found' });

      const inativa = { query: jest.fn().mockResolvedValue({ rows: [{ active: false, has_phone: true }] }) } as unknown as PoolClient;
      expect(await repo.mark(PID, 'RESPONSIBLE', RID, inativa)).toEqual({ outcome: 'not_found' });
    });

    it('requires_phone quando a linha está ativa mas sem telefone (D-A #3)', async () => {
      const client = { query: jest.fn().mockResolvedValue({ rows: [{ active: true, has_phone: false }] }) } as unknown as PoolClient;
      expect(await repo.mark(PID, 'EXTERNAL', XID, client)).toEqual({ outcome: 'requires_phone' });
    });

    it('marked: UPDATE grava a coluna do kind e LIMPA a do outro conjunto (num_nonnulls <= 1)', async () => {
      const client = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [{ active: true, has_phone: true }] })
          .mockResolvedValueOnce({ rows: [] }),
      } as unknown as PoolClient;
      expect(await repo.mark(PID, 'RESPONSIBLE', RID, client)).toEqual({ outcome: 'marked' });
      const [sql, params] = (client.query as jest.Mock).mock.calls[1] as [string, unknown[]];
      expect(sql).toMatch(/UPDATE patients SET emergency_responsible_id = \$2, emergency_external_contact_id = NULL WHERE id = \$1/);
      expect(params).toEqual([PID, RID]);
    });

    it('marcar EXTERNAL limpa emergency_responsible_id (a mesma troca, invertida)', async () => {
      const client = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [{ active: true, has_phone: true }] })
          .mockResolvedValueOnce({ rows: [] }),
      } as unknown as PoolClient;
      await repo.mark(PID, 'EXTERNAL', XID, client);
      const [sql, params] = (client.query as jest.Mock).mock.calls[1] as [string, unknown[]];
      expect(sql).toMatch(/UPDATE patients SET emergency_external_contact_id = \$2, emergency_responsible_id = NULL WHERE id = \$1/);
      expect(params).toEqual([PID, XID]);
    });
  });

  describe('unmark', () => {
    it('limpa as duas colunas de uma vez (no máximo 1 estava preenchida)', async () => {
      const client = { query: jest.fn().mockResolvedValue({ rows: [] }) } as unknown as PoolClient;
      await repo.unmark(PID, client);
      const [sql, params] = (client.query as jest.Mock).mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/UPDATE patients SET emergency_responsible_id = NULL, emergency_external_contact_id = NULL WHERE id = \$1/);
      expect(params).toEqual([PID]);
    });
  });
});
