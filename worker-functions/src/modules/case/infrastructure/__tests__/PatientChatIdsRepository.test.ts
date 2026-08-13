import type { Pool, PoolClient } from 'pg';
import { PatientChatIdsRepository } from '../PatientChatIdsRepository';
import { toRoleCatalog, type PatientChatRoleSpec } from '../../domain/PatientChatRole';

/**
 * O catálogo entra por parâmetro — o repositório não o lê do banco. Aqui ele é o
 * que a 262 semeia: FAMILY/PROVIDERS exclusivos, HEALTH_PLAN compartilhável.
 * É o que prova que `is_exclusive` gravado na linha é DERIVADO daqui.
 */
const CATALOG = toRoleCatalog(
  (
    [
      ['FAMILY', true],
      ['PROVIDERS', true],
      ['HEALTH_PLAN', false],
    ] as const
  ).map(([code, isExclusive], i): PatientChatRoleSpec => ({
    code,
    labelEs: code,
    labelPtBr: code,
    isExclusive,
    displayOrder: i,
    isActive: true,
    matchKeywords: [],
  })),
);

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: jest.fn() }) }) },
}));

const PATIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';

function poolWith(query: jest.Mock): Pool {
  return { query } as unknown as Pool;
}

/** Pool com `connect()` para o caminho transacional de `applyChatIds`. */
function poolWithClient(clientQuery: jest.Mock): { pool: Pool; release: jest.Mock } {
  const release = jest.fn();
  const client = { query: clientQuery, release } as unknown as PoolClient;
  const pool = { connect: jest.fn().mockResolvedValue(client) } as unknown as Pool;
  return { pool, release };
}

/**
 * Unit com pool falso: cobre a FORMA da query (filtros de soft-delete, exclusão
 * do próprio paciente, transação) e o mapeamento. A prova de que o SQL roda de
 * verdade — e de que as constraints da migration 261 mordem — está no e2e contra
 * Postgres real (tests/e2e/patient-chat-ids.e2e.test.ts).
 */
describe('PatientChatIdsRepository', () => {
  describe('findById', () => {
    it('devolve a linha com o mapa de papéis e filtra soft-delete', async () => {
      const row = {
        id: PATIENT, firstName: 'Maria', lastName: 'Perez',
        chatIds: { FAMILY: '1@g.us' },
      };
      const query = jest.fn().mockResolvedValue({ rows: [row] });

      const out = await new PatientChatIdsRepository(poolWith(query)).findById(PATIENT);

      expect(out).toEqual(row);
      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('deleted_at IS NULL');
      expect(sql).toContain('jsonb_object_agg(c.role, c.chat_id)');
      expect(params).toEqual([PATIENT]);
    });

    it('devolve null quando não existe', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [] });
      expect(await new PatientChatIdsRepository(poolWith(query)).findById(PATIENT)).toBeNull();
    });
  });

  describe('findLinkedElsewhere', () => {
    it('lê a exclusividade da COLUNA — é a mesma que o índice parcial enxerga', async () => {
      // A coluna é a cópia DERIVADA do catálogo (a 262 semeia e o
      // PatientChatRolesRepository.update a mantém em dia, na mesma transação).
      // Ler daqui e não do catálogo carregado é de propósito: um papel
      // DESATIVADO não está no catálogo ativo, mas os vínculos dele continuam
      // segurando o grupo no banco — e é isso que precisa aparecer no conflito.
      const query = jest.fn().mockResolvedValue({
        rows: [
          { chatId: '1@g.us', patientId: OTHER, role: 'FAMILY', exclusive: true },
          { chatId: '3@g.us', patientId: 'p3', role: 'HEALTH_PLAN', exclusive: false },
        ],
      });

      const out = await new PatientChatIdsRepository(poolWith(query)).findLinkedElsewhere(PATIENT);

      expect(out).toEqual([
        { chatId: '1@g.us', patientId: OTHER, role: 'FAMILY', exclusive: true },
        { chatId: '3@g.us', patientId: 'p3', role: 'HEALTH_PLAN', exclusive: false },
      ]);
      expect(query.mock.calls[0][0]).toContain('c.is_exclusive AS "exclusive"');
    });

    it('exclui o próprio paciente e o soft-deleted na query', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [] });
      await new PatientChatIdsRepository(poolWith(query)).findLinkedElsewhere(PATIENT);

      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('c.patient_id <> $1');
      expect(sql).toContain('p.deleted_at IS NULL');
      expect(params).toEqual([PATIENT]);
    });

    it('nenhum vínculo → lista vazia', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [] });
      expect(await new PatientChatIdsRepository(poolWith(query)).findLinkedElsewhere(PATIENT)).toEqual([]);
    });
  });

  describe('findChatMap (leitura em massa)', () => {
    function poolFor(rows: unknown[], total: string) {
      return jest.fn()
        .mockResolvedValueOnce({ rows })
        .mockResolvedValueOnce({ rows: [{ total }] });
    }

    it('seleciona SÓ identificadores — nenhuma coluna de PII no SQL', async () => {
      const query = poolFor([], '0');
      await new PatientChatIdsRepository(poolWith(query)).findChatMap({
        filter: 'linked', limit: 10, offset: 0,
      });

      const [sql] = query.mock.calls[0];
      expect(sql).toContain('"patientId"');
      expect(sql).toContain('"clickupTaskId"');
      expect(sql).toContain('"chatIds"');
      for (const pii of ['first_name', 'last_name', 'phone_whatsapp', 'document_number', 'birth_date']) {
        expect(sql).not.toContain(pii);
      }
    });

    it('filtra soft-delete, ordena por id e pagina', async () => {
      const query = poolFor([], '0');
      await new PatientChatIdsRepository(poolWith(query)).findChatMap({
        filter: 'linked', limit: 25, offset: 50,
      });

      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('p.deleted_at IS NULL');
      expect(sql).toContain('ORDER BY p.id');
      expect(params).toEqual([25, 50]);
    });

    it.each([
      ['linked', 'EXISTS (SELECT 1 FROM patient_chat_ids c WHERE c.patient_id = p.id)'],
      ['unlinked', 'NOT EXISTS (SELECT 1 FROM patient_chat_ids c WHERE c.patient_id = p.id)'],
      ['all', 'TRUE'],
    ] as const)('filtro %s vira o WHERE certo', async (filter, expected) => {
      const query = poolFor([], '0');
      await new PatientChatIdsRepository(poolWith(query)).findChatMap({ filter, limit: 1, offset: 0 });

      expect(query.mock.calls[0][0]).toContain(expected);
      // o mesmo recorte vale para a contagem, senão total e página divergem
      expect(query.mock.calls[1][0]).toContain(expected);
    });

    it('devolve as linhas e o total convertido para número', async () => {
      const row = { patientId: PATIENT, clickupTaskId: 'cu-1', chatIds: { FAMILY: '1@g.us' } };
      const query = poolFor([row], '357');

      const out = await new PatientChatIdsRepository(poolWith(query)).findChatMap({
        filter: 'linked', limit: 10, offset: 0,
      });

      expect(out).toEqual({ rows: [row], total: 357 });
      expect(typeof out.total).toBe('number');
    });
  });

  describe('findByChatId (direção reversa)', () => {
    it('busca na tabela de vínculos e devolve o papel que bateu', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [] });
      await new PatientChatIdsRepository(poolWith(query)).findByChatId('1@g.us');

      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('FROM patient_chat_ids m');
      expect(sql).toContain('m.chat_id = $1');
      expect(sql).toContain('"matchedRole"');
      expect(sql).toContain('p.deleted_at IS NULL');
      expect(params).toEqual(['1@g.us']);
    });

    it('não seleciona nenhuma coluna de PII', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [] });
      await new PatientChatIdsRepository(poolWith(query)).findByChatId('1@g.us');

      const [sql] = query.mock.calls[0];
      for (const pii of ['first_name', 'last_name', 'phone_whatsapp', 'document_number']) {
        expect(sql).not.toContain(pii);
      }
    });

    it('chat sem dono devolve lista vazia', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [] });
      expect(await new PatientChatIdsRepository(poolWith(query)).findByChatId('1@g.us')).toEqual([]);
    });

    it('devolve as linhas encontradas', async () => {
      const row = {
        patientId: PATIENT, clickupTaskId: null,
        chatIds: { FAMILY: '1@g.us' }, matchedRole: 'FAMILY',
      };
      const query = jest.fn().mockResolvedValue({ rows: [row] });
      expect(await new PatientChatIdsRepository(poolWith(query)).findByChatId('1@g.us')).toEqual([row]);
    });
  });

  describe('applyChatIds', () => {
    /** BEGIN, os writes, o toque no paciente, o SELECT final e o COMMIT. */
    function transactionalQuery(finalRows: Array<{ role: string; chatId: string }>) {
      return jest.fn().mockImplementation((sql: string) => {
        if (sql.startsWith('SELECT role')) return Promise.resolve({ rows: finalRows });
        return Promise.resolve({ rows: [], rowCount: 1 });
      });
    }

    it('faz UPSERT do papel com valor e grava is_exclusive do catálogo', async () => {
      const clientQuery = transactionalQuery([{ role: 'FAMILY', chatId: '1@g.us' }]);
      const { pool, release } = poolWithClient(clientQuery);

      const out = await new PatientChatIdsRepository(pool).applyChatIds(PATIENT, { FAMILY: '1@g.us' }, CATALOG);

      expect(out).toEqual({ FAMILY: '1@g.us' });
      const insert = clientQuery.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO patient_chat_ids'));
      expect(insert![1]).toEqual([PATIENT, 'FAMILY', '1@g.us', true]);
      expect(insert![0]).toContain('ON CONFLICT (patient_id, role)');
      expect(clientQuery.mock.calls[0][0]).toBe('BEGIN');
      expect(clientQuery.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(true);
      expect(release).toHaveBeenCalled();
    });

    it('MOVER grupo entre papéis: o DELETE vem antes do INSERT, nos dois sentidos', async () => {
      // Regressão achada em review (11/08). `Object.entries` seguia a ordem do
      // body, então mover um grupo de PROVIDERS para FAMILY numa gravação só
      // podia rodar o INSERT antes do DELETE que libera o grupo → violação de
      // `patient_chat_ids_one_role_per_chat` → rollback → 409 "já vinculado a
      // outro paciente", que é FALSO (é o mesmo paciente) e deixava a correção
      // impossível pela tela. O sentido inverso passava por acaso.
      //
      // Por isso as duas ordens são testadas: o bug era assimétrico, e testar só
      // uma delas dava verde num código quebrado.
      for (const changes of [
        { FAMILY: '7@g.us', PROVIDERS: null },
        { PROVIDERS: null, FAMILY: '7@g.us' },
      ] as const) {
        const clientQuery = transactionalQuery([{ role: 'FAMILY', chatId: '7@g.us' }]);
        const { pool } = poolWithClient(clientQuery);

        await new PatientChatIdsRepository(pool).applyChatIds(PATIENT, { ...changes }, CATALOG);

        const idxDelete = clientQuery.mock.calls.findIndex(([sql]) =>
          String(sql).startsWith('DELETE FROM patient_chat_ids'),
        );
        const idxInsert = clientQuery.mock.calls.findIndex(([sql]) =>
          String(sql).includes('INSERT INTO patient_chat_ids'),
        );
        expect(idxDelete).toBeGreaterThan(-1);
        expect(idxInsert).toBeGreaterThan(-1);
        expect(idxDelete).toBeLessThan(idxInsert);
      }
    });

    it('papel COMPARTILHÁVEL grava is_exclusive=false — a coluna segue o catálogo', async () => {
      // Sem isto o índice parcial trancaria o grupo do plano de saúde no
      // primeiro paciente, e os outros 235 levariam 409 sem ninguém entender.
      const clientQuery = transactionalQuery([{ role: 'HEALTH_PLAN', chatId: '3@g.us' }]);
      const { pool } = poolWithClient(clientQuery);

      await new PatientChatIdsRepository(pool).applyChatIds(
        PATIENT,
        { HEALTH_PLAN: '3@g.us' },
        CATALOG,
      );

      const insert = clientQuery.mock.calls.find(([sql]) =>
        String(sql).includes('INSERT INTO patient_chat_ids'),
      );
      expect(insert![1]).toEqual([PATIENT, 'HEALTH_PLAN', '3@g.us', false]);
    });

    it('papel fora do catálogo recebido aqui grava is_exclusive=true (na dúvida, tranca)', async () => {
      const clientQuery = transactionalQuery([{ role: 'MANAGEMENT', chatId: '9@g.us' }]);
      const { pool } = poolWithClient(clientQuery);

      await new PatientChatIdsRepository(pool).applyChatIds(
        PATIENT,
        { MANAGEMENT: '9@g.us' },
        CATALOG,
      );

      const insert = clientQuery.mock.calls.find(([sql]) =>
        String(sql).includes('INSERT INTO patient_chat_ids'),
      );
      expect(insert![1]).toEqual([PATIENT, 'MANAGEMENT', '9@g.us', true]);
    });

    it('null APAGA a linha do papel, e não grava string vazia', async () => {
      const clientQuery = transactionalQuery([]);
      const { pool } = poolWithClient(clientQuery);

      const out = await new PatientChatIdsRepository(pool).applyChatIds(PATIENT, { PROVIDERS: null }, CATALOG);

      expect(out).toEqual({});
      const del = clientQuery.mock.calls.find(([sql]) => String(sql).startsWith('DELETE FROM patient_chat_ids'));
      expect(del![1]).toEqual([PATIENT, 'PROVIDERS']);
      expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO patient_chat_ids'))).toBe(false);
    });

    it('papel AUSENTE não vira write nenhum (não apaga o que a versão antiga não conhece)', async () => {
      const clientQuery = transactionalQuery([
        { role: 'FAMILY', chatId: '1@g.us' },
        { role: 'HEALTH_PLAN', chatId: '3@g.us' },
      ]);
      const { pool } = poolWithClient(clientQuery);

      await new PatientChatIdsRepository(pool).applyChatIds(PATIENT, { FAMILY: '1@g.us' }, CATALOG);

      // A invariante é sobre PAPÉIS: só o papel presente no body é tocado
      // (o mesmo papel pode gerar mais de um statement — o DELETE condicional
      // de reescrita + o INSERT — e isso não fere a garantia).
      const touchedRoles = new Set(
        clientQuery.mock.calls
          .filter(([sql]) => String(sql).includes('patient_chat_ids') && !String(sql).startsWith('SELECT role'))
          .map(([, params]) => (params as string[])[1]),
      );
      expect([...touchedRoles]).toEqual(['FAMILY']);
    });

    it('toca updated_at do paciente e devolve o estado FINAL lido do banco', async () => {
      const clientQuery = transactionalQuery([
        { role: 'FAMILY', chatId: '1@g.us' },
        { role: 'HEALTH_PLAN', chatId: '3@g.us' },
      ]);
      const { pool } = poolWithClient(clientQuery);

      const out = await new PatientChatIdsRepository(pool).applyChatIds(PATIENT, { FAMILY: '1@g.us' }, CATALOG);

      expect(out).toEqual({ FAMILY: '1@g.us', HEALTH_PLAN: '3@g.us' });
      expect(
        clientQuery.mock.calls.some(([sql]) => String(sql).includes('UPDATE patients SET updated_at')),
      ).toBe(true);
    });

    it('erro no meio faz ROLLBACK, solta o client e propaga', async () => {
      const boom = Object.assign(new Error('unique_violation'), { code: '23505' });
      const clientQuery = jest.fn().mockImplementation((sql: string) => {
        if (String(sql).includes('INSERT INTO patient_chat_ids')) return Promise.reject(boom);
        return Promise.resolve({ rows: [] });
      });
      const { pool, release } = poolWithClient(clientQuery);

      await expect(
        new PatientChatIdsRepository(pool).applyChatIds(PATIENT, { FAMILY: '1@g.us' }, CATALOG),
      ).rejects.toBe(boom);

      expect(clientQuery.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(true);
      expect(clientQuery.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false);
      expect(release).toHaveBeenCalled();
    });
  });

  it('sem pool injetado, cai no pool da aplicação', () => {
    expect(() => new PatientChatIdsRepository()).not.toThrow();
  });
});
