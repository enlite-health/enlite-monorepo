import type { Pool } from 'pg';
import { PatientChatIdsRepository } from '../PatientChatIdsRepository';

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: jest.fn() }) }) },
}));

const PATIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';

function poolWith(query: jest.Mock): Pool {
  return { query } as unknown as Pool;
}

/**
 * Unit com pool falso: cobre a FORMA da query (filtros de soft-delete, exclusão
 * do próprio paciente) e o mapeamento. A prova de que o SQL roda de verdade —
 * e de que as constraints da migration 260 mordem — está no e2e contra Postgres
 * real (tests/e2e/patient-chat-ids.e2e.test.ts).
 */
describe('PatientChatIdsRepository', () => {
  describe('findById', () => {
    it('devolve a linha e filtra soft-delete', async () => {
      const row = { id: PATIENT, firstName: 'Maria', lastName: 'Perez', familyChatId: null, providersChatId: null };
      const query = jest.fn().mockResolvedValue({ rows: [row] });

      const out = await new PatientChatIdsRepository(poolWith(query)).findById(PATIENT);

      expect(out).toEqual(row);
      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('deleted_at IS NULL');
      expect(params).toEqual([PATIENT]);
    });

    it('devolve null quando não existe', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [] });
      expect(await new PatientChatIdsRepository(poolWith(query)).findById(PATIENT)).toBeNull();
    });
  });

  describe('findLinkedElsewhere', () => {
    it('achata os dois papéis em conflitos, ignorando colunas nulas', async () => {
      const query = jest.fn().mockResolvedValue({
        rows: [
          { id: OTHER, family: '1@g.us', providers: '2@g.us' },
          { id: 'p3', family: null, providers: '3@g.us' },
          { id: 'p4', family: '4@g.us', providers: null },
        ],
      });

      const out = await new PatientChatIdsRepository(poolWith(query)).findLinkedElsewhere(PATIENT);

      expect(out).toEqual([
        { chatId: '1@g.us', patientId: OTHER, role: 'family' },
        { chatId: '2@g.us', patientId: OTHER, role: 'providers' },
        { chatId: '3@g.us', patientId: 'p3', role: 'providers' },
        { chatId: '4@g.us', patientId: 'p4', role: 'family' },
      ]);
    });

    it('exclui o próprio paciente e o soft-deleted na query', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [] });
      await new PatientChatIdsRepository(poolWith(query)).findLinkedElsewhere(PATIENT);

      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('id <> $1');
      expect(sql).toContain('deleted_at IS NULL');
      expect(params).toEqual([PATIENT]);
    });

    it('nenhum vínculo → lista vazia', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [] });
      expect(await new PatientChatIdsRepository(poolWith(query)).findLinkedElsewhere(PATIENT)).toEqual([]);
    });
  });

  describe('updateChatIds', () => {
    it('grava os dois campos e toca updated_at', async () => {
      const query = jest.fn().mockResolvedValue({ rowCount: 1 });

      const ok = await new PatientChatIdsRepository(poolWith(query)).updateChatIds(PATIENT, {
        familyChatId: '1@g.us', providersChatId: '2@g.us',
      });

      expect(ok).toBe(true);
      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('updated_at        = NOW()');
      expect(params).toEqual([PATIENT, '1@g.us', '2@g.us']);
    });

    it('false quando nenhuma linha foi atingida', async () => {
      const query = jest.fn().mockResolvedValue({ rowCount: 0 });
      expect(
        await new PatientChatIdsRepository(poolWith(query)).updateChatIds(PATIENT, {
          familyChatId: null, providersChatId: null,
        }),
      ).toBe(false);
    });

    it('rowCount ausente conta como zero linha', async () => {
      const query = jest.fn().mockResolvedValue({});
      expect(
        await new PatientChatIdsRepository(poolWith(query)).updateChatIds(PATIENT, {
          familyChatId: null, providersChatId: null,
        }),
      ).toBe(false);
    });
  });

  it('sem pool injetado, cai no pool da aplicação', () => {
    expect(() => new PatientChatIdsRepository()).not.toThrow();
  });
});
