import type { Pool, PoolClient } from 'pg';
import { PatientChatRolesRepository } from '../PatientChatRolesRepository';

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: jest.fn() }) }) },
}));

function poolWith(query: jest.Mock): Pool {
  return { query } as unknown as Pool;
}

function poolWithClient(clientQuery: jest.Mock): { pool: Pool; release: jest.Mock } {
  const release = jest.fn();
  const client = { query: clientQuery, release } as unknown as PoolClient;
  const pool = { connect: jest.fn().mockResolvedValue(client) } as unknown as Pool;
  return { pool, release };
}

const ROW = {
  code: 'FAMILY',
  labelEs: 'Grupo de la familia',
  labelPtBr: 'Grupo da família',
  isExclusive: true,
  displayOrder: 1,
  isActive: true,
  matchKeywords: ['flia'],
};

/**
 * Unit com pool falso: cobre a FORMA da query e a transação. A prova de que o
 * SQL roda e de que as constraints da 262 mordem está no e2e contra Postgres
 * real (tests/e2e/patient-chat-roles.e2e.test.ts).
 */
describe('PatientChatRolesRepository', () => {
  describe('leitura', () => {
    it('listAll traz ativos E inativos, na ordem de exibição', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [ROW] });
      const out = await new PatientChatRolesRepository(poolWith(query)).listAll();

      expect(out).toEqual([ROW]);
      const [sql] = query.mock.calls[0];
      expect(sql).not.toContain('WHERE is_active');
      expect(sql).toContain('ORDER BY display_order, code');
    });

    it('listActive filtra os desativados', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [ROW] });
      await new PatientChatRolesRepository(poolWith(query)).listActive();
      expect(query.mock.calls[0][0]).toContain('WHERE is_active');
    });

    it('findByCode devolve null quando não existe', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [] });
      expect(await new PatientChatRolesRepository(poolWith(query)).findByCode('NOPE')).toBeNull();
    });

    it('as três leituras usam a MESMA lista de colunas — não podem divergir', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [] });
      const repo = new PatientChatRolesRepository(poolWith(query));
      await repo.listAll();
      await repo.listActive();
      await repo.findByCode('FAMILY');

      for (const [sql] of query.mock.calls) {
        for (const col of ['label_es', 'label_pt_br', 'is_exclusive', 'display_order', 'is_active', 'match_keywords']) {
          expect(sql).toContain(col);
        }
      }
    });
  });

  describe('create', () => {
    it('grava os seis campos e devolve a linha', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [ROW] });
      const out = await new PatientChatRolesRepository(poolWith(query)).create({
        code: 'FAMILY',
        labelEs: 'Grupo de la familia',
        labelPtBr: 'Grupo da família',
        isExclusive: true,
        displayOrder: 1,
        matchKeywords: ['flia'],
      });

      expect(out).toEqual(ROW);
      expect(query.mock.calls[0][1]).toEqual([
        'FAMILY', 'Grupo de la familia', 'Grupo da família', true, 1, ['flia'],
      ]);
    });
  });

  describe('update — a política e a cópia derivada, na MESMA transação', () => {
    function txQuery(row: unknown = ROW) {
      return jest.fn().mockImplementation((sql: string) => {
        if (String(sql).startsWith('UPDATE patient_chat_roles')) {
          return Promise.resolve({ rows: row ? [row] : [] });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });
    }

    it('virar a política atualiza patient_chat_ids junto, dentro da transação', async () => {
      // Sem isto, a coluna derivada mentiria para o índice parcial: o papel
      // ficaria compartilhável na tela e trancado no banco — ou pior, deixaria
      // de trancar sem ninguém saber.
      const clientQuery = txQuery();
      const { pool, release } = poolWithClient(clientQuery);

      await new PatientChatRolesRepository(pool).update('HEALTH_PLAN', { isExclusive: false });

      const sqls = clientQuery.mock.calls.map(([sql]) => String(sql));
      expect(sqls[0]).toBe('BEGIN');
      expect(sqls.some(s => s.startsWith('UPDATE patient_chat_roles'))).toBe(true);
      const derived = clientQuery.mock.calls.find(([sql]) =>
        String(sql).includes('UPDATE patient_chat_ids'),
      );
      expect(derived![1]).toEqual(['HEALTH_PLAN', false]);
      // só toca o que está diferente — re-rodar não infla updated_at à toa
      expect(derived![0]).toContain('is_exclusive IS DISTINCT FROM $2');
      expect(sqls).toContain('COMMIT');
      expect(release).toHaveBeenCalled();
    });

    it('sem `isExclusive` no body, NÃO toca a tabela de vínculos', async () => {
      const clientQuery = txQuery();
      const { pool } = poolWithClient(clientQuery);

      await new PatientChatRolesRepository(pool).update('FAMILY', { labelEs: 'Novo' });

      expect(
        clientQuery.mock.calls.some(([sql]) => String(sql).includes('UPDATE patient_chat_ids')),
      ).toBe(false);
    });

    it('monta o SET só com os campos mandados', async () => {
      const clientQuery = txQuery();
      const { pool } = poolWithClient(clientQuery);

      await new PatientChatRolesRepository(pool).update('FAMILY', {
        labelPtBr: 'Família',
        displayOrder: 9,
      });

      const [sql, params] = clientQuery.mock.calls.find(([s]) =>
        String(s).startsWith('UPDATE patient_chat_roles'),
      )!;
      // Só o trecho do SET: `label_es` aparece no RETURNING de toda leitura.
      const setClause = String(sql).split('WHERE')[0];
      expect(setClause).toContain('label_pt_br = $2');
      expect(setClause).toContain('display_order = $3');
      expect(setClause).not.toContain('label_es');
      expect(params).toEqual(['FAMILY', 'Família', 9]);
    });

    it('body sem nenhum campo não abre transação — só lê', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [ROW] });
      const connect = jest.fn();
      const pool = { query, connect } as unknown as Pool;

      await new PatientChatRolesRepository(pool).update('FAMILY', {});

      expect(connect).not.toHaveBeenCalled();
      expect(query.mock.calls[0][0]).toContain('WHERE code = $1');
    });

    it('papel inexistente: ROLLBACK e null (não COMMIT de nada)', async () => {
      const clientQuery = txQuery(null);
      const { pool, release } = poolWithClient(clientQuery);

      const out = await new PatientChatRolesRepository(pool).update('NOPE', { labelEs: 'x' });

      expect(out).toBeNull();
      const sqls = clientQuery.mock.calls.map(([sql]) => String(sql));
      expect(sqls).toContain('ROLLBACK');
      expect(sqls).not.toContain('COMMIT');
      expect(release).toHaveBeenCalled();
    });

    it('erro no meio faz ROLLBACK, solta o client e propaga', async () => {
      const boom = new Error('boom');
      const clientQuery = jest.fn().mockImplementation((sql: string) => {
        if (String(sql).startsWith('UPDATE patient_chat_roles')) return Promise.reject(boom);
        return Promise.resolve({ rows: [] });
      });
      const { pool, release } = poolWithClient(clientQuery);

      await expect(
        new PatientChatRolesRepository(pool).update('FAMILY', { labelEs: 'x' }),
      ).rejects.toBe(boom);

      expect(clientQuery.mock.calls.map(([s]) => String(s))).toContain('ROLLBACK');
      expect(release).toHaveBeenCalled();
    });
  });

  describe('countUsage', () => {
    it('conta PACIENTES distintos e ignora soft-deleted', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [{ n: '21' }] });
      const out = await new PatientChatRolesRepository(poolWith(query)).countUsage('FAMILY');

      expect(out).toBe(21);
      expect(typeof out).toBe('number');
      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('COUNT(DISTINCT ci.patient_id)');
      expect(sql).toContain('p.deleted_at IS NULL');
      expect(params).toEqual(['FAMILY']);
    });
  });

  describe('findSharedGroups', () => {
    it('devolve só os grupos que hoje pertencem a MAIS DE UM paciente', async () => {
      const query = jest.fn().mockResolvedValue({
        rows: [{ chatId: '1@g.us', patientCount: '3' }],
      });

      const out = await new PatientChatRolesRepository(poolWith(query)).findSharedGroups('HEALTH_PLAN');

      expect(out).toEqual([{ chatId: '1@g.us', patientCount: 3 }]);
      expect(query.mock.calls[0][0]).toContain('HAVING COUNT(DISTINCT patient_id) > 1');
      expect(query.mock.calls[0][0]).toContain('p.deleted_at IS NULL');
    });

    it('olha ALÉM do papel — o índice que a trava protege é global sobre chat_id', () => {
      // Regressão achada em review (11/08): a query filtrava `WHERE ci.role = $1`,
      // mas `idx_patient_chat_ids_exclusive_chat` é global e parcial só em
      // `is_exclusive`. Um grupo dividido entre DOIS papéis compartilhados de
      // pacientes diferentes passava na checagem (dentro do papel havia 1 só) e
      // criava a contagem dupla que esta trava existe para impedir.
      //
      // Asserção sobre a FORMA da pergunta, não sobre o texto: o universo tem que
      // incluir as linhas já exclusivas de qualquer papel.
      const query = jest.fn().mockResolvedValue({ rows: [] });
      return new PatientChatRolesRepository(poolWith(query))
        .findSharedGroups('HEALTH_PLAN')
        .then(() => {
          const sql = String(query.mock.calls[0][0]);
          expect(sql).toContain('ci.is_exclusive');
          expect(sql).toMatch(/ci\.role\s*=\s*\$1\s+OR\s+ci\.is_exclusive/);
        });
    });

    it('nenhum grupo dividido → lista vazia (a virada pode seguir)', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [] });
      expect(
        await new PatientChatRolesRepository(poolWith(query)).findSharedGroups('HEALTH_PLAN'),
      ).toEqual([]);
    });
  });

  it('delete devolve false quando não achou linha', async () => {
    const query = jest.fn().mockResolvedValue({ rowCount: 0 });
    expect(await new PatientChatRolesRepository(poolWith(query)).delete('NOPE')).toBe(false);
  });

  it('nenhuma query seleciona coluna de PII — papel não é dado de pessoa', async () => {
    // `COUNT(...)` sempre devolve uma linha, daí o `rows` não-vazio aqui.
    const query = jest.fn().mockResolvedValue({ rows: [{ n: '0' }], rowCount: 0 });
    const repo = new PatientChatRolesRepository(poolWith(query));
    await repo.listAll();
    await repo.countUsage('FAMILY');
    await repo.findSharedGroups('FAMILY');

    for (const [sql] of query.mock.calls) {
      for (const pii of ['first_name', 'last_name', 'phone_whatsapp', 'document_number']) {
        expect(String(sql)).not.toContain(pii);
      }
    }
  });

  it('sem pool injetado, cai no pool da aplicação', () => {
    expect(() => new PatientChatRolesRepository()).not.toThrow();
  });
});
