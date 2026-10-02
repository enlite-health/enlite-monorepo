import { installFetchMethodCounter } from '../fetchMethodCounter';

describe('installFetchMethodCounter', () => {
  it('conta por método; só o login é POST tolerado; o resto não-GET é escrita; restore devolve o fetch', async () => {
    const original = jest.fn().mockResolvedValue({ ok: true });
    const target = { fetch: original as unknown as typeof fetch };
    const c = installFetchMethodCounter(target);

    await target.fetch('https://api.x/projects?page=1');
    await target.fetch(new URL('https://api.x/projects'), { method: 'get' });
    await target.fetch('https://api.x/auth/login', { method: 'POST', body: 'segredo' });
    expect(c.stats()).toEqual({ byMethod: { GET: 2, POST: 1 }, writes: 0 });

    await target.fetch({ url: 'https://api.x/projects/1', method: 'DELETE' } as unknown as Request);
    await target.fetch({ url: 'https://api.x/projects/1' } as unknown as Request);
    expect(c.stats()).toEqual({ byMethod: { GET: 3, POST: 1, DELETE: 1 }, writes: 1 });
    expect(original).toHaveBeenCalledTimes(5);

    c.restore();
    expect(target.fetch).toBe(original);
  });

  it('por padrão embrulha o fetch global', () => {
    const before = globalThis.fetch;
    const c = installFetchMethodCounter();
    expect(globalThis.fetch).not.toBe(before);
    c.restore();
    expect(globalThis.fetch).toBe(before);
  });
});
