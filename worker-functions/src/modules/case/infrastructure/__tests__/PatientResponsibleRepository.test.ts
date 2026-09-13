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

import { PatientResponsibleRepository, ResponsiblePrimaryAlreadySetError } from '../PatientResponsibleRepository';
import { EmergencyContactRequiresPhoneError } from '../EmergencyContactRequiresPhoneError';
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

  describe('insertOne/updateOne/deactivate (escrita por linha — spec 018, PR-1, ADR-1)', () => {
    it('insertOne: INSERT com PII cifrada, trim nos nomes, source default admin_manual, created_by = ator; display_order é MAX+1 EM SQL, nunca vem do chamador', async () => {
      const client = { query: jest.fn().mockResolvedValue({ rows: [{ id: 'novo' }] }) } as unknown as PoolClient;
      const out = await repo.insertOne(PID, row({ source: undefined, displayOrder: 0 }), 'uid-staff', client);
      expect(out).toEqual({ id: 'novo' });
      const [sql, params] = (client.query as jest.Mock).mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('INSERT INTO patient_responsibles');
      expect(sql).toContain('created_by');
      // O molde é `PatientAddressRepository.insertOne` (repositório irmão): `display_order` é
      // subquery MAX+1, nunca um valor passado — achado do gate `revisao-pr` (ordem indeterminada
      // com dois não-titulares empatados em `display_order`).
      expect(sql).toMatch(/COALESCE\(MAX\(display_order\),\s*0\)\s*\+\s*1/);
      expect(params).toEqual([PID, 'Ana', 'Lima', 'PARENT', b64('+54911'), b64('a@b.co'), b64('123'), 'DNI', true, 'admin_manual', 'uid-staff']);
      expect(mockPoolQuery).not.toHaveBeenCalled(); // usou o client, não o pool
    });

    it('insertOne: campos opcionais AUSENTES viram null (phone/email/documentNumber/relationship/documentType)', async () => {
      const client = { query: jest.fn().mockResolvedValue({ rows: [{ id: 'novo' }] }) } as unknown as PoolClient;
      const minimo: Omit<PatientResponsibleInput, 'displayOrder'> = { firstName: 'B', lastName: 'C', isPrimary: false };
      await repo.insertOne(PID, minimo, 'uid-staff', client);
      const [, params] = (client.query as jest.Mock).mock.calls[0] as [string, unknown[]];
      expect(params).toEqual([PID, 'B', 'C', null, null, null, null, null, false, 'admin_manual', 'uid-staff']);
    });

    it('insertOne: 23505 no índice de titular único vira ResponsiblePrimaryAlreadySetError (409 legível)', async () => {
      const client = {
        query: jest.fn().mockRejectedValue({ code: '23505', constraint: 'idx_patient_responsibles_one_primary' }),
      } as unknown as PoolClient;
      await expect(repo.insertOne(PID, row(), 'uid', client)).rejects.toBeInstanceOf(ResponsiblePrimaryAlreadySetError);
    });

    it('updateOne: 23514 do trigger de bloqueio (apagar telefone de responsável marcado, migration 423) vira EmergencyContactRequiresPhoneError (422 legível)', async () => {
      const erro23514 = Object.assign(new Error('boom'), { code: '23514' });
      const client = { query: jest.fn().mockRejectedValue(erro23514) } as unknown as PoolClient;
      await expect(repo.updateOne(PID, 'r1', { phone: null }, client)).rejects.toBeInstanceOf(EmergencyContactRequiresPhoneError);
    });

    it('insertOne: outro erro (não é o índice de titular) passa intocado', async () => {
      const erroQualquer = Object.assign(new Error('boom'), { code: '23502' });
      const client = { query: jest.fn().mockRejectedValue(erroQualquer) } as unknown as PoolClient;
      await expect(repo.insertOne(PID, row(), 'uid', client)).rejects.toBe(erroQualquer);
    });

    it('updateOne: só as chaves presentes viram SET; `null` explícito apaga; ausente não toca', async () => {
      const client = { query: jest.fn().mockResolvedValue({ rows: [{ id: 'r1' }] }) } as unknown as PoolClient;
      const out = await repo.updateOne(PID, 'r1', { phone: null, firstName: ' Nova ' }, client);
      expect(out).toEqual({ id: 'r1' });
      const [sql, params] = (client.query as jest.Mock).mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/SET first_name = \$3, phone_encrypted = \$4, updated_at = NOW\(\)/);
      expect(sql).toMatch(/WHERE id = \$2 AND patient_id = \$1/);
      expect(params).toEqual([PID, 'r1', 'Nova', null]);
    });

    // Achado do gate `revisao-pr`: um PATCH {} respondia 200 sem checar NADA — id de outro
    // paciente, linha inexistente ou já desativada também virava `{ id }`. Agora o no-op ainda
    // não faz UPDATE, mas CONFERE posse/existência/`active` com a MESMA régua do UPDATE real.
    describe('updateOne: PATCH vazio ({}) é no-op, mas verifica a linha antes de responder', () => {
      it('linha existe, é do paciente e está ativa → { id } (SELECT, nunca UPDATE)', async () => {
        const client = { query: jest.fn().mockResolvedValue({ rows: [{ id: 'r1' }] }) } as unknown as PoolClient;
        const out = await repo.updateOne(PID, 'r1', {}, client);
        expect(out).toEqual({ id: 'r1' });
        const [sql, params] = (client.query as jest.Mock).mock.calls[0] as [string, unknown[]];
        expect(sql).toMatch(/^SELECT id FROM patient_responsibles WHERE id = \$2 AND patient_id = \$1 AND active/);
        expect(sql).not.toMatch(/UPDATE/);
        expect(params).toEqual([PID, 'r1']);
      });

      it('linha de OUTRO paciente, inexistente ou desativada → null (404 no controller), nunca 200 cego', async () => {
        const client = { query: jest.fn().mockResolvedValue({ rows: [] }) } as unknown as PoolClient;
        const out = await repo.updateOne('outro-paciente', 'r1', {}, client);
        expect(out).toBeNull();
      });
    });

    it('updateOne: todas as OUTRAS chaves (lastName, relationship, documentType, isPrimary, email, documentNumber) viram SET, cada uma no seu branch', async () => {
      const client = { query: jest.fn().mockResolvedValue({ rows: [{ id: 'r1' }] }) } as unknown as PoolClient;
      await repo.updateOne(PID, 'r1', {
        lastName: ' Lima ', relationship: null, documentType: null, isPrimary: true, email: 'a@b.co', documentNumber: '123',
      }, client);
      const [sql, params] = (client.query as jest.Mock).mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/SET last_name = \$3, relationship = \$4, document_type = \$5, is_primary = \$6, email_encrypted = \$7, document_number_encrypted = \$8, updated_at = NOW\(\)/);
      expect(params).toEqual([PID, 'r1', 'Lima', null, null, true, b64('a@b.co'), b64('123')]);
    });

    it('updateOne: `null` explícito em email/documentNumber apaga (mesmo `?? null` do phone)', async () => {
      const client = { query: jest.fn().mockResolvedValue({ rows: [{ id: 'r1' }] }) } as unknown as PoolClient;
      await repo.updateOne(PID, 'r1', { email: null, documentNumber: null }, client);
      const [sql, params] = (client.query as jest.Mock).mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/SET email_encrypted = \$3, document_number_encrypted = \$4, updated_at = NOW\(\)/);
      expect(params).toEqual([PID, 'r1', null, null]);
    });

    it('updateOne: linha de outro paciente, inexistente OU já desativada por outra aba (task 1.10 alt 2) → null; a query leva `AND active`', async () => {
      const client = { query: jest.fn().mockResolvedValue({ rows: [] }) } as unknown as PoolClient;
      expect(await repo.updateOne(PID, 'r1', { firstName: 'X' }, client)).toBeNull();
      const [sql] = (client.query as jest.Mock).mock.calls[0] as [string];
      expect(sql).toMatch(/WHERE id = \$2 AND patient_id = \$1 AND active/);
    });

    it('updateOne: promover a titular colidindo com outro ativo → ResponsiblePrimaryAlreadySetError', async () => {
      const client = {
        query: jest.fn().mockRejectedValue({ code: '23505', constraint: 'idx_patient_responsibles_one_primary' }),
      } as unknown as PoolClient;
      await expect(repo.updateOne(PID, 'r1', { isPrimary: true }, client)).rejects.toBeInstanceOf(ResponsiblePrimaryAlreadySetError);
    });

    it('deactivate: SELECT … FOR UPDATE decide not_found/already_inactive/deactivated (nunca DELETE)', async () => {
      const notFound = { query: jest.fn().mockResolvedValue({ rows: [] }) } as unknown as PoolClient;
      expect(await repo.deactivate(PID, 'r1', 'uid', notFound)).toEqual({ outcome: 'not_found' });
      expect(notFound.query).toHaveBeenCalledTimes(1);

      const jaInativo = { query: jest.fn().mockResolvedValue({ rows: [{ id: 'r1', active: false }] }) } as unknown as PoolClient;
      expect(await repo.deactivate(PID, 'r1', 'uid', jaInativo)).toEqual({ outcome: 'already_inactive' });
      expect(jaInativo.query).toHaveBeenCalledTimes(1);

      // migration 423 (spec 018, PR-2, D-A #4): entre o SELECT…FOR UPDATE e o UPDATE, o
      // `deactivateRow` agora consulta `patients.emergency_responsible_id` para relatar
      // `emergencyMarkCleared` — 3 chamadas, não mais 2.
      const ativo = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [{ id: 'r1', active: true }] })
          .mockResolvedValueOnce({ rows: [{ marked: false }] })
          .mockResolvedValueOnce({ rows: [] }),
      } as unknown as PoolClient;
      expect(await repo.deactivate(PID, 'r1', 'uid-staff', ativo)).toEqual({ outcome: 'deactivated', id: 'r1', emergencyMarkCleared: false });
      const [markSql, markParams] = (ativo.query as jest.Mock).mock.calls[1] as [string, unknown[]];
      expect(markSql).toMatch(/SELECT \(emergency_responsible_id = \$2\) AS marked FROM patients WHERE id = \$1/);
      expect(markParams).toEqual([PID, 'r1']);
      const [updSql, updParams] = (ativo.query as jest.Mock).mock.calls[2] as [string, unknown[]];
      expect(updSql).toMatch(/SET active = false, deactivated_at = NOW\(\), deactivated_by = \$3/);
      expect(updSql).not.toMatch(/^DELETE/);
      expect(updParams).toEqual([PID, 'r1', 'uid-staff']);
    });

    it('deactivate: quando a linha desativada ERA a marca de emergência, emergencyMarkCleared vem true (o trigger da 423 já limpou patients.emergency_responsible_id na mesma transação)', async () => {
      const marcado = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [{ id: 'r1', active: true }] })
          .mockResolvedValueOnce({ rows: [{ marked: true }] })
          .mockResolvedValueOnce({ rows: [] }),
      } as unknown as PoolClient;
      expect(await repo.deactivate(PID, 'r1', 'uid-staff', marcado)).toEqual({ outcome: 'deactivated', id: 'r1', emergencyMarkCleared: true });
    });
  });
});
