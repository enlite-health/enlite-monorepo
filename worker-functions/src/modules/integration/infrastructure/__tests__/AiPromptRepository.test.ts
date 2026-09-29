/**
 * AiPromptRepository — molde: PostgresPatientDiagnosisRepository.test.ts (pool/client
 * mockados; a prova de que o SQL real funciona fica para o e2e da Fase 2, T014).
 */
const mockPoolQuery = jest.fn();
const mockClientQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue({ query: mockPoolQuery }) }),
  },
}));

import type { PoolClient } from 'pg';
import { AiPromptRepository } from '../AiPromptRepository';

const ROW = {
  slug: 'VACANCY_DESCRIPTION' as const,
  body: 'Texto do prompt de vaga.',
  version: 7,
  is_active: true,
  created_by: 'uid-criador',
  updated_by: 'uid-editor',
  created_at: new Date('2026-09-01T00:00:00Z'),
  updated_at: new Date('2026-09-29T12:00:00Z'),
};

describe('AiPromptRepository (spec 029 T007)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('findBySlug', () => {
    it('devolve a Entity mapeada quando a linha existe', async () => {
      const repo = new AiPromptRepository();
      mockPoolQuery.mockResolvedValueOnce({ rows: [ROW], rowCount: 1 });

      const found = await repo.findBySlug('VACANCY_DESCRIPTION');

      expect(found).toEqual({
        slug: 'VACANCY_DESCRIPTION',
        body: 'Texto do prompt de vaga.',
        version: 7,
        isActive: true,
        createdBy: 'uid-criador',
        updatedBy: 'uid-editor',
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-29T12:00:00.000Z',
      });
      const [sql, params] = mockPoolQuery.mock.calls[0];
      expect(sql).toContain('FROM ai_prompts WHERE slug = $1');
      expect(params).toEqual(['VACANCY_DESCRIPTION']);
    });

    it('devolve null quando o slug não tem linha', async () => {
      const repo = new AiPromptRepository();
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      expect(await repo.findBySlug('PRESCREENING_AT')).toBeNull();
    });

    it('mapeia created_at/updated_at quando o driver já devolve string (branch não-Date de toIso)', async () => {
      const repo = new AiPromptRepository();
      const rowComStrings = {
        ...ROW,
        created_at: '2026-09-01T00:00:00.000Z',
        updated_at: '2026-09-29T12:00:00.000Z',
      };
      mockPoolQuery.mockResolvedValueOnce({ rows: [rowComStrings], rowCount: 1 });

      const found = await repo.findBySlug('VACANCY_DESCRIPTION');

      expect(found?.createdAt).toBe('2026-09-01T00:00:00.000Z');
      expect(found?.updatedAt).toBe('2026-09-29T12:00:00.000Z');
    });
  });

  describe('listAll', () => {
    it('devolve todas as linhas mapeadas, ORDER BY slug', async () => {
      const repo = new AiPromptRepository();
      const segunda = { ...ROW, slug: 'PRESCREENING_AT' as const, version: 1 };
      mockPoolQuery.mockResolvedValueOnce({ rows: [segunda, ROW], rowCount: 2 });

      const all = await repo.listAll();

      expect(all).toHaveLength(2);
      expect(all[0].slug).toBe('PRESCREENING_AT');
      expect(all[1].slug).toBe('VACANCY_DESCRIPTION');
      const [sql, params] = mockPoolQuery.mock.calls[0];
      expect(sql).toContain('ORDER BY slug');
      expect(params).toBeUndefined();
    });

    it('devolve lista vazia quando não há linha nenhuma', async () => {
      const repo = new AiPromptRepository();
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      expect(await repo.listAll()).toEqual([]);
    });
  });

  describe('updateBody', () => {
    it('grava e devolve outcome updated quando a versão bate — usa o pool quando nenhum client é passado', async () => {
      const repo = new AiPromptRepository();
      const atualizado = { ...ROW, body: 'Texto novo.', version: 8, updated_by: 'uid-novo' };
      mockPoolQuery.mockResolvedValueOnce({ rows: [atualizado], rowCount: 1 });

      const result = await repo.updateBody('VACANCY_DESCRIPTION', 'Texto novo.', 7, 'uid-novo');

      expect(result).toEqual({
        outcome: 'updated',
        prompt: expect.objectContaining({ body: 'Texto novo.', version: 8, updatedBy: 'uid-novo' }),
      });
      const [sql, params] = mockPoolQuery.mock.calls[0];
      expect(sql).toContain('UPDATE ai_prompts');
      expect(sql).toContain('version = version + 1');
      expect(sql).toContain('WHERE slug = $3 AND version = $4');
      expect(params).toEqual(['Texto novo.', 'uid-novo', 'VACANCY_DESCRIPTION', 7]);
      // Sem client explícito, usa o pool memoizado — nunca um PoolClient de transação.
      expect(mockClientQuery).not.toHaveBeenCalled();
    });

    it('grava pelo client da transação quando ele é passado (T010 grava trilha na mesma transação)', async () => {
      const repo = new AiPromptRepository();
      const atualizado = { ...ROW, version: 8 };
      mockClientQuery.mockResolvedValueOnce({ rows: [atualizado], rowCount: 1 });
      const fakeClient = { query: mockClientQuery } as unknown as PoolClient;

      const result = await repo.updateBody('VACANCY_DESCRIPTION', 'Texto novo.', 7, 'uid-novo', fakeClient);

      expect(result.outcome).toBe('updated');
      expect(mockClientQuery).toHaveBeenCalledTimes(1);
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });

    it('devolve conflict com a versão atual e quem gravou por último quando a versão diverge — não grava de novo', async () => {
      const repo = new AiPromptRepository();
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // UPDATE não achou linha (versão velha)
        .mockResolvedValueOnce({ rows: [{ version: 9, updated_by: 'uid-outra-pessoa' }], rowCount: 1 }); // SELECT desambiguador

      const result = await repo.updateBody('VACANCY_DESCRIPTION', 'Texto novo.', 7, 'uid-novo');

      expect(result).toEqual({ outcome: 'conflict', currentVersion: 9, updatedBy: 'uid-outra-pessoa' });
      expect(mockPoolQuery).toHaveBeenCalledTimes(2);
      const [selectSql, selectParams] = mockPoolQuery.mock.calls[1];
      expect(selectSql).toContain('SELECT version, updated_by FROM ai_prompts WHERE slug = $1');
      expect(selectParams).toEqual(['VACANCY_DESCRIPTION']);
    });

    it('devolve not_found quando o slug não existe nenhuma linha (a segunda pergunta também vem vazia)', async () => {
      const repo = new AiPromptRepository();
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // UPDATE não achou linha
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // SELECT desambiguador: slug nem existe

      const result = await repo.updateBody('PRESCREENING_CAREGIVER', 'Texto novo.', 1, 'uid-novo');

      expect(result).toEqual({ outcome: 'not_found' });
    });

    it('trata rowCount undefined do UPDATE como 0 (branch `?? 0` do driver que não informa rowCount)', async () => {
      const repo = new AiPromptRepository();
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [], rowCount: undefined }) // UPDATE sem rowCount
        .mockResolvedValueOnce({ rows: [{ version: 9, updated_by: 'uid-outra-pessoa' }], rowCount: 1 });

      const result = await repo.updateBody('VACANCY_DESCRIPTION', 'Texto novo.', 7, 'uid-novo');

      expect(result).toEqual({ outcome: 'conflict', currentVersion: 9, updatedBy: 'uid-outra-pessoa' });
    });

    it('trata rowCount undefined do SELECT desambiguador como 0 (branch `?? 0` → not_found)', async () => {
      const repo = new AiPromptRepository();
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // UPDATE não achou linha
        .mockResolvedValueOnce({ rows: [], rowCount: undefined }); // SELECT sem rowCount

      const result = await repo.updateBody('PRESCREENING_CAREGIVER', 'Texto novo.', 1, 'uid-novo');

      expect(result).toEqual({ outcome: 'not_found' });
    });
  });
});
