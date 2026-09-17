/**
 * AnaCareEnliteDirectory.test.ts — raspagem das duas páginas HTML do painel admin.
 * Sem rede real: o `AnaCareSessionClient` é um stub controlado (`requestText` mockado).
 */
import { AnaCareEnliteDirectory, AnaCareEnliteDirectoryError } from '../AnaCareEnliteDirectory';
import type { AnaCareSessionClient } from '../AnaCareSessionClient';

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

describe('AnaCareEnliteDirectory', () => {
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
});
