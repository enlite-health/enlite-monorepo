/**
 * ClickUpTaskListGateway — Unit Tests
 *
 * Verifica o I/O contra a API do ClickUp: montagem dos parâmetros (incluindo
 * date_updated_gt da janela incremental), paginação até last_page, propagação
 * de erro HTTP e o filtro de lista no fetchById.
 */

import {
  ClickUpTaskListGateway,
  PATIENT_LIST_ID,
} from '../../../src/modules/integration/infrastructure/clickup/ClickUpTaskListGateway';

const TOKEN = 'pk_test_token';

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
  } as unknown as Response;
}

function errResponse(status: number, statusText: string): Response {
  return { ok: false, status, statusText, json: async () => ({}) } as unknown as Response;
}

function task(id: string, listId: string = PATIENT_LIST_ID): Record<string, unknown> {
  return { id, list: { id: listId } };
}

describe('ClickUpTaskListGateway', () => {
  describe('fetchUpdatedSince', () => {
    it('envia date_updated_gt com o timestamp da janela e os filtros padrão', async () => {
      const calls: string[] = [];
      const fetchFn = jest.fn(async (url: string) => {
        calls.push(url);
        return okResponse({ tasks: [task('a')], last_page: true });
      });

      const gw = new ClickUpTaskListGateway(TOKEN, PATIENT_LIST_ID, fetchFn as unknown as typeof fetch);
      const result = await gw.fetchUpdatedSince(1_700_000_000_000);

      expect(result).toHaveLength(1);
      expect(calls[0]).toContain(`/list/${PATIENT_LIST_ID}/task`);
      expect(calls[0]).toContain('date_updated_gt=1700000000000');
      expect(calls[0]).toContain('archived=false');
      expect(calls[0]).toContain('subtasks=false');
      expect(calls[0]).toContain('include_closed=true');
    });

    it('trunca timestamp fracionado (a API do ClickUp espera inteiro)', async () => {
      const calls: string[] = [];
      const fetchFn = jest.fn(async (url: string) => {
        calls.push(url);
        return okResponse({ tasks: [], last_page: true });
      });

      const gw = new ClickUpTaskListGateway(TOKEN, PATIENT_LIST_ID, fetchFn as unknown as typeof fetch);
      await gw.fetchUpdatedSince(1_700_000_000_123.9);

      expect(calls[0]).toContain('date_updated_gt=1700000000123');
    });

    it('envia o token no header Authorization', async () => {
      const fetchFn = jest.fn(async () => okResponse({ tasks: [], last_page: true }));
      const gw = new ClickUpTaskListGateway(TOKEN, PATIENT_LIST_ID, fetchFn as unknown as typeof fetch);

      await gw.fetchUpdatedSince(0);

      expect(fetchFn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ headers: { Authorization: TOKEN } }),
      );
    });
  });

  describe('paginação', () => {
    it('segue páginas até last_page e concatena', async () => {
      const pages = [
        { tasks: [task('a'), task('b')], last_page: false },
        { tasks: [task('c')], last_page: true },
      ];
      let i = 0;
      const fetchFn = jest.fn(async () => okResponse(pages[i++]));

      const gw = new ClickUpTaskListGateway(TOKEN, PATIENT_LIST_ID, fetchFn as unknown as typeof fetch);
      const result = await gw.fetchAll();

      expect(result.map(t => t.id)).toEqual(['a', 'b', 'c']);
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it('para quando a página vem vazia mesmo sem last_page', async () => {
      const fetchFn = jest.fn(async () => okResponse({ tasks: [], last_page: false }));
      const gw = new ClickUpTaskListGateway(TOKEN, PATIENT_LIST_ID, fetchFn as unknown as typeof fetch);

      const result = await gw.fetchAll();

      expect(result).toEqual([]);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('incrementa o número da página a cada chamada', async () => {
      const calls: string[] = [];
      const pages = [
        { tasks: [task('a')], last_page: false },
        { tasks: [task('b')], last_page: true },
      ];
      let i = 0;
      const fetchFn = jest.fn(async (url: string) => {
        calls.push(url);
        return okResponse(pages[i++]);
      });

      const gw = new ClickUpTaskListGateway(TOKEN, PATIENT_LIST_ID, fetchFn as unknown as typeof fetch);
      await gw.fetchAll();

      expect(calls[0]).toContain('page=0');
      expect(calls[1]).toContain('page=1');
    });
  });

  describe('erros', () => {
    it('propaga erro HTTP da listagem com página na mensagem', async () => {
      const fetchFn = jest.fn(async () => errResponse(429, 'Too Many Requests'));
      const gw = new ClickUpTaskListGateway(TOKEN, PATIENT_LIST_ID, fetchFn as unknown as typeof fetch);

      await expect(gw.fetchAll()).rejects.toThrow(/HTTP 429 Too Many Requests \(página 0\)/);
    });

    it('propaga erro HTTP do fetchById', async () => {
      const fetchFn = jest.fn(async () => errResponse(404, 'Not Found'));
      const gw = new ClickUpTaskListGateway(TOKEN, PATIENT_LIST_ID, fetchFn as unknown as typeof fetch);

      await expect(gw.fetchById('abc')).rejects.toThrow(/GET \/task\/abc falhou: HTTP 404/);
    });
  });

  describe('fetchById', () => {
    it('devolve a task quando ela pertence à lista de pacientes', async () => {
      const fetchFn = jest.fn(async () => okResponse(task('abc')));
      const gw = new ClickUpTaskListGateway(TOKEN, PATIENT_LIST_ID, fetchFn as unknown as typeof fetch);

      const result = await gw.fetchById('abc');

      expect(result?.id).toBe('abc');
    });

    it('devolve null quando a task foi movida para outra lista', async () => {
      const fetchFn = jest.fn(async () => okResponse(task('abc', '999999')));
      const gw = new ClickUpTaskListGateway(TOKEN, PATIENT_LIST_ID, fetchFn as unknown as typeof fetch);

      const result = await gw.fetchById('abc');

      expect(result).toBeNull();
    });
  });
});
