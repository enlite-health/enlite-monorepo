/**
 * AnaCareEnliteDirectory.test.ts — raspagem das duas páginas HTML do painel admin.
 * Sem rede real: o `AnaCareSessionClient` é um stub controlado (`requestText` mockado).
 */
import { AnaCareEnliteDirectory, AnaCareEnliteDirectoryError } from '../AnaCareEnliteDirectory';
import type { AnaCareSessionClient } from '../AnaCareSessionClient';
import { AnaCareHttpError } from '../AnaCareHttpError';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
const { logger } = jest.requireMock('@shared/logging') as { logger: { warn: jest.Mock } };

function htmlWithAccounts(ids: string[]): string {
  const rows = ids.map((id) => `<tr><td><a href="/accounts/${id}/">conta ${id}</a></td></tr>`).join('\n');
  return `<html><body><table>${rows}</table></body></html>`;
}

function htmlWithoutAccounts(): string {
  return '<html><body><table><tr><td>nenhum resultado</td></tr></table></body></html>';
}

function makeClient(requestText: jest.Mock): AnaCareSessionClient {
  return { requestText } as unknown as AnaCareSessionClient;
}

/** Ids `${from}..${from+n-1}` — páginas de ativos sintéticas. */
function range(from: number, n: number): string[] {
  return Array.from({ length: n }, (_, i) => String(from + i));
}

describe('AnaCareEnliteDirectory', () => {
  beforeEach(() => logger.warn.mockClear());

  it('caminho feliz: une ativos + terminados sem duplicata e conta por origem', async () => {
    const requestText = jest.fn(async (path: string) => {
      if (path === '/admin/accounts/') return htmlWithAccounts(['1', '2', '3']);
      if (path === '/admin/accounts/terminated_services') return htmlWithAccounts(['4', '5']);
      throw new Error(`unexpected path: ${path}`);
    });
    const directory = new AnaCareEnliteDirectory(makeClient(requestText));

    const result = await directory.fetch();

    expect(result.partial).toBe(false);
    expect(result.counts).toEqual({ activo: 3, terminado: 2, total: 5 });
    expect(result.entries).toHaveLength(5);
    expect(result.entries.filter((e) => e.origin === 'activo').map((e) => e.reservationId).sort()).toEqual(['1', '2', '3']);
    expect(result.entries.filter((e) => e.origin === 'terminado').map((e) => e.reservationId).sort()).toEqual(['4', '5']);
  });

  it('caminho feliz: id repetido na MESMA página não duplica (dedupe por Set)', async () => {
    const requestText = jest.fn(async (path: string) => {
      if (path === '/admin/accounts/') return htmlWithAccounts(['1', '1', '2']);
      if (path === '/admin/accounts/terminated_services') return htmlWithAccounts(['4']);
      throw new Error(`unexpected path: ${path}`);
    });
    const directory = new AnaCareEnliteDirectory(makeClient(requestText));

    const result = await directory.fetch();

    expect(result.counts).toEqual({ activo: 2, terminado: 1, total: 3 });
  });

  it('página de TERMINADOS falha (erro de rede) — marca partial e preserva os ATIVOS, sem descartar em silêncio', async () => {
    const requestText = jest.fn(async (path: string) => {
      if (path === '/admin/accounts/') return htmlWithAccounts(['1', '2']);
      if (path === '/admin/accounts/terminated_services') throw new Error('500 upstream');
      throw new Error(`unexpected path: ${path}`);
    });
    const directory = new AnaCareEnliteDirectory(makeClient(requestText));

    const result = await directory.fetch();

    expect(result.partial).toBe(true);
    expect(result.counts).toEqual({ activo: 2, terminado: 0, total: 2 });
    expect(result.entries.every((e) => e.origin === 'activo')).toBe(true);
  });

  it('página de TERMINADOS devolve HTML sem nenhuma conta — também marca partial (zero é falha, tratada como quebra dessa página, não some com os ativos)', async () => {
    const requestText = jest.fn(async (path: string) => {
      if (path === '/admin/accounts/') return htmlWithAccounts(['1', '2']);
      if (path === '/admin/accounts/terminated_services') return htmlWithoutAccounts();
      throw new Error(`unexpected path: ${path}`);
    });
    const directory = new AnaCareEnliteDirectory(makeClient(requestText));

    const result = await directory.fetch();

    expect(result.partial).toBe(true);
    expect(result.counts).toEqual({ activo: 2, terminado: 0, total: 2 });
  });

  it('página de ATIVOS sem nenhuma conta LANÇA — nunca devolve diretório vazio em silêncio (contagem zero é falha, não sucesso)', async () => {
    const requestText = jest.fn(async (path: string) => {
      if (path === '/admin/accounts/') return htmlWithoutAccounts();
      throw new Error(`unexpected path: ${path}`);
    });
    const directory = new AnaCareEnliteDirectory(makeClient(requestText));

    await expect(directory.fetch()).rejects.toThrow(AnaCareEnliteDirectoryError);
  });

  it('página de ATIVOS falha (erro de rede) — o erro sobe, não existe diretório parcial sem os ativos', async () => {
    const requestText = jest.fn(async (path: string) => {
      if (path === '/admin/accounts/') throw new Error('500 upstream');
      throw new Error(`unexpected path: ${path}`);
    });
    const directory = new AnaCareEnliteDirectory(makeClient(requestText));

    await expect(directory.fetch()).rejects.toThrow('500 upstream');
  });

  describe('paginação de ATIVOS (?tab=clients&page=N)', () => {
    it('3 páginas (25, 25, 10) + página 4 repetindo a 3 → total 60 e PARA de pedir na página 4', async () => {
      const pages: Record<number, string[]> = { 1: range(1, 25), 2: range(26, 25), 3: range(51, 10), 4: range(51, 10) };
      const requestText = jest.fn(async (path: string, query?: { page?: number }) => {
        if (path === '/admin/accounts/') return htmlWithAccounts(pages[query?.page ?? 1] ?? pages[4]);
        if (path === '/admin/accounts/terminated_services') return htmlWithAccounts(['9001']);
        throw new Error(`unexpected path: ${path}`);
      });

      const result = await new AnaCareEnliteDirectory(makeClient(requestText)).fetch();

      expect(result.counts.activo).toBe(60);
      const activePages = requestText.mock.calls.filter(([p]) => p === '/admin/accounts/').map(([, q]) => (q as { page: number }).page);
      expect(activePages).toEqual([1, 2, 3, 4]);
      expect(requestText).toHaveBeenCalledWith('/admin/accounts/', { tab: 'clients', page: 2 });
    });

    it('sem paginação (página 2 repete a 1) → total = página 1', async () => {
      const requestText = jest.fn(async (path: string) => {
        if (path === '/admin/accounts/') return htmlWithAccounts(['1', '2', '3']);
        if (path === '/admin/accounts/terminated_services') return htmlWithAccounts(['4']);
        throw new Error(`unexpected path: ${path}`);
      });

      const result = await new AnaCareEnliteDirectory(makeClient(requestText)).fetch();

      expect(result.counts.activo).toBe(3);
      expect(requestText.mock.calls.filter(([p]) => p === '/admin/accounts/')).toHaveLength(2);
    });

    it('teto de páginas atingido com ids sempre novos → LANÇA, nunca devolve diretório truncado', async () => {
      const requestText = jest.fn(async (path: string, query?: { page?: number }) => {
        if (path === '/admin/accounts/') return htmlWithAccounts([String(7000 + (query?.page ?? 0))]);
        throw new Error(`unexpected path: ${path}`);
      });

      await expect(new AnaCareEnliteDirectory(makeClient(requestText)).fetch()).rejects.toThrow(AnaCareEnliteDirectoryError);
      expect(requestText).toHaveBeenCalledTimes(50);
    });
  });

  it('falha da página de TERMINADOS é LOGADA só com campos seguros (status/path/classe), NUNCA o corpo da resposta, e marca partial', async () => {
    const err = new AnaCareHttpError('GET', '/admin/accounts/terminated_services', 500, '<html>NOME_SENSIVEL</html>');
    expect(err.message).toContain('NOME_SENSIVEL'); // premissa: a mensagem do erro real embute o corpo
    const requestText = jest.fn(async (path: string) => {
      if (path === '/admin/accounts/') return htmlWithAccounts(['1']);
      throw err;
    });

    const result = await new AnaCareEnliteDirectory(makeClient(requestText)).fetch();

    expect(result.partial).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const args = JSON.stringify(logger.warn.mock.calls);
    expect(args).not.toContain('NOME_SENSIVEL');
    expect(logger.warn.mock.calls[0][0]).toMatchObject({ status: 500, errorName: 'AnaCareHttpError' });
  });
});
