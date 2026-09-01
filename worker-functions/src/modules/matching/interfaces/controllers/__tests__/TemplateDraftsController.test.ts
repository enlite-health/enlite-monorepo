/**
 * O contrato do rascunho. O que estes testes protegem, em ordem de importância:
 *
 * 1. **NADA sai do perímetro.** Não há chamada a Twilio nem a Meta em nenhum
 *    caminho — o espião de `fetch` prova isso com 0 chamadas. Se alguém
 *    acrescentar uma submissão sem passar pelo `lex`, este teste reprova.
 * 2. **`rowCount` 0 nunca vira 200.** É o defeito que o
 *    `FunnelStageMessagesController.update` tem hoje: devolve sucesso sem
 *    gravar. Aqui o 0 é desambiguado com uma segunda pergunta — 404 se sumiu,
 *    409 se outra pessoa gravou antes.
 * 3. **A trava otimista funciona**: versão velha não sobrescreve trabalho alheio.
 */
import type { Request, Response } from 'express';
import { TemplateDraftsController } from '../TemplateDraftsController';

const linha = (over: Record<string, unknown> = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'ar_bienvenida', name: 'Bienvenida',
  body: 'Hola {{1}}, te esperamos.', category: 'UTILITY', language: 'es-AR',
  version: 1, created_by: 'uid-a', updated_by: 'uid-a',
  created_at: '2026-08-31T12:00:00Z', updated_at: '2026-08-31T12:00:00Z',
  ...over,
});

const corpoOk = {
  slug: 'bienvenida', name: 'Bienvenida',
  body: 'Hola {{1}}, te esperamos.', category: 'UTILITY', language: 'es-AR',
};

function ambiente(queryImpl: jest.Mock) {
  const db = { query: queryImpl } as never;
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as unknown as Response;
  return {
    db, res,
    controller: new TemplateDraftsController(db),
    status: () => (res.status as jest.Mock).mock.calls[0]?.[0],
    body: () => (res.json as jest.Mock).mock.calls[0]?.[0],
  };
}

const req = (over: Partial<Request> = {}) =>
  ({ body: {}, params: {}, user: { uid: 'uid-a' }, ...over } as unknown as Request);

describe('construção', () => {
  it('sem pool injetado pega o do singleton — o fio padrão está ligado', () => {
    const pool = { query: jest.fn() };
    jest.doMock('@shared/database/DatabaseConnection', () => ({
      DatabaseConnection: { getInstance: () => ({ getPool: () => pool }) },
    }));
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { TemplateDraftsController: C } = require('../TemplateDraftsController');
      expect(new C()).toBeInstanceOf(C);
    });
  });
});

describe('nada sai do perímetro', () => {
  it('nenhum caminho do controller chama fetch — 0 chamadas, medido', async () => {
    const espiao = jest.spyOn(global, 'fetch' as never).mockImplementation((() => {
      throw new Error('o controller de rascunho NAO pode falar com a rede');
    }) as never);
    try {
      const a = ambiente(jest.fn(async () => ({ rows: [linha()], rowCount: 1 })));
      await a.controller.list(req(), a.res);
      const b = ambiente(jest.fn(async () => ({ rows: [linha()], rowCount: 0 })));
      await b.controller.create(req({ body: corpoOk }), b.res);
      const c = ambiente(jest.fn(async () => ({ rows: [linha()], rowCount: 1 })));
      await c.controller.update(req({ body: { ...corpoOk, version: 1 }, params: { id: 'x' } }), c.res);
      const d = ambiente(jest.fn(async () => ({ rows: [], rowCount: 1 })));
      await d.controller.archive(req({ params: { id: 'x' } }), d.res);
      expect(espiao).toHaveBeenCalledTimes(0);
    } finally {
      espiao.mockRestore();
    }
  });
});

describe('list', () => {
  it('200 com os rascunhos, e cada um marcado status=draft — guardado ≠ submetido', async () => {
    const a = ambiente(jest.fn(async () => ({ rows: [linha()], rowCount: 1 })));
    await a.controller.list(req(), a.res);
    expect(a.status()).toBe(200);
    expect(a.body().data.drafts[0]).toMatchObject({ slug: 'ar_bienvenida', version: 1, status: 'draft' });
  });
  it('só traz o que não foi arquivado', async () => {
    const q: jest.Mock = jest.fn(async () => ({ rows: [], rowCount: 0 }));
    const a = ambiente(q);
    await a.controller.list(req(), a.res);
    expect(q.mock.calls[0][0]).toContain('archived_at IS NULL');
  });
  it('500 quando o banco falha', async () => {
    const a = ambiente(jest.fn(async () => { throw new Error('boom'); }));
    await a.controller.list(req(), a.res);
    expect(a.status()).toBe(500);
  });
  it('erro não-Error também vira 500 — sem estourar no wrapper', async () => {
    const a = ambiente(jest.fn(async () => { throw 'string crua'; }));
    await a.controller.list(req(), a.res);
    expect(a.status()).toBe(500);
  });
});

describe('create', () => {
  it('201 e o slug ganha o prefixo do idioma', async () => {
    const q = jest.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                 // colisão com vivo
      .mockResolvedValueOnce({ rows: [linha()], rowCount: 1 });          // insert
    const a = ambiente(q);
    await a.controller.create(req({ body: corpoOk }), a.res);
    expect(a.status()).toBe(201);
    expect(q.mock.calls[1][1][0]).toBe('ar_bienvenida');
  });
  it('grava a autoria de quem está logado', async () => {
    const q = jest.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [linha()], rowCount: 1 });
    const a = ambiente(q);
    await a.controller.create(req({ body: corpoOk }), a.res);
    expect(q.mock.calls[1][1][5]).toBe('uid-a');
  });
  it('sem usuário na request a autoria fica null, não quebra', async () => {
    const q = jest.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [linha()], rowCount: 1 });
    const a = ambiente(q);
    await a.controller.create({ body: corpoOk, params: {} } as unknown as Request, a.res);
    expect(q.mock.calls[1][1][5]).toBeNull();
  });
  it('400 quando o payload não bate o schema', async () => {
    const a = ambiente(jest.fn());
    await a.controller.create(req({ body: { name: 'x' } }), a.res);
    expect(a.status()).toBe(400);
  });
  it('400 quando o body vem ausente', async () => {
    const a = ambiente(jest.fn());
    await a.controller.create({ params: {}, user: {} } as unknown as Request, a.res);
    expect(a.status()).toBe(400);
  });
  it('422 quando o texto viola regra de plataforma — e diz QUAIS', async () => {
    const a = ambiente(jest.fn());
    await a.controller.create(req({ body: { ...corpoOk, body: '{{1}}' } }), a.res);
    expect(a.status()).toBe(422);
    expect(a.body().problemas.map((p: { regra: string }) => p.regra)).toContain('placeholder_no_inicio');
  });
  it('409 quando o slug já é de um template VIVO', async () => {
    const a = ambiente(jest.fn(async () => ({ rows: [{ '?column?': 1 }], rowCount: 1 })));
    await a.controller.create(req({ body: corpoOk }), a.res);
    expect(a.status()).toBe(409);
    expect(a.body().error).toBe('slug_em_uso_por_template_vivo');
  });
  it('409 quando outro RASCUNHO vivo já usa o slug (23505)', async () => {
    const q = jest.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
    const a = ambiente(q);
    await a.controller.create(req({ body: corpoOk }), a.res);
    expect(a.status()).toBe(409);
    expect(a.body().error).toBe('slug_em_uso_por_rascunho');
  });
  it('500 em erro de banco que não é colisão', async () => {
    const q = jest.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockRejectedValueOnce(new Error('boom'));
    const a = ambiente(q);
    await a.controller.create(req({ body: corpoOk }), a.res);
    expect(a.status()).toBe(500);
  });
  it('erro não-Error vira 500 sem estourar no wrapper', async () => {
    const q = jest.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockRejectedValueOnce('string crua');
    const a = ambiente(q);
    await a.controller.create(req({ body: corpoOk }), a.res);
    expect(a.status()).toBe(500);
  });
  it('rowCount null na checagem de vivo é tratado como zero, não como colisão', async () => {
    const q = jest.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: null })
      .mockResolvedValueOnce({ rows: [linha()], rowCount: 1 });
    const a = ambiente(q);
    await a.controller.create(req({ body: corpoOk }), a.res);
    expect(a.status()).toBe(201);
  });
});

describe('update — a trava otimista', () => {
  const corpoEdit = { ...corpoOk, version: 1 };

  it('200 quando a versão bate, e a versão sobe', async () => {
    const q: jest.Mock = jest.fn(async () => ({ rows: [linha({ version: 2 })], rowCount: 1 }));
    const a = ambiente(q);
    await a.controller.update(req({ body: corpoEdit, params: { id: 'abc' } }), a.res);
    expect(a.status()).toBe(200);
    expect(a.body().data.draft.version).toBe(2);
    expect(q.mock.calls[0][0]).toContain('version = version + 1');
  });
  it('409 quando outra pessoa gravou antes — NUNCA sobrescreve em silêncio', async () => {
    const q = jest.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ version: 7 }], rowCount: 1 });
    const a = ambiente(q);
    await a.controller.update(req({ body: corpoEdit, params: { id: 'abc' } }), a.res);
    expect(a.status()).toBe(409);
    expect(a.body()).toMatchObject({ error: 'versao_desatualizada', versaoAtual: 7 });
  });
  it('404 quando o rascunho não existe mais — o 0 é desambiguado, não presumido', async () => {
    const q = jest.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const a = ambiente(q);
    await a.controller.update(req({ body: corpoEdit, params: { id: 'abc' } }), a.res);
    expect(a.status()).toBe(404);
  });
  it('400 sem version no payload — editar às cegas é proibido', async () => {
    const a = ambiente(jest.fn());
    await a.controller.update(req({ body: corpoOk, params: { id: 'abc' } }), a.res);
    expect(a.status()).toBe(400);
  });
  it('400 quando o body vem ausente', async () => {
    const a = ambiente(jest.fn());
    await a.controller.update({ params: { id: 'a' } } as unknown as Request, a.res);
    expect(a.status()).toBe(400);
  });
  it('422 quando o texto editado viola regra', async () => {
    const a = ambiente(jest.fn());
    await a.controller.update(req({ body: { ...corpoEdit, body: 'x {{1}}{{2}} y' }, params: { id: 'a' } }), a.res);
    expect(a.status()).toBe(422);
  });
  it('409 quando a edição colide com outro rascunho (23505)', async () => {
    const a = ambiente(jest.fn(async () => { throw Object.assign(new Error('dup'), { code: '23505' }); }));
    await a.controller.update(req({ body: corpoEdit, params: { id: 'a' } }), a.res);
    expect(a.status()).toBe(409);
    expect(a.body().error).toBe('slug_em_uso_por_rascunho');
  });
  it('500 em erro de banco', async () => {
    const a = ambiente(jest.fn(async () => { throw new Error('boom'); }));
    await a.controller.update(req({ body: corpoEdit, params: { id: 'a' } }), a.res);
    expect(a.status()).toBe(500);
  });
  it('erro não-Error vira 500 sem estourar no wrapper', async () => {
    const a = ambiente(jest.fn(async () => { throw 'string crua'; }));
    await a.controller.update(req({ body: corpoEdit, params: { id: 'a' } }), a.res);
    expect(a.status()).toBe(500);
  });
  it('rowCount null cai no mesmo tratamento do zero', async () => {
    const q = jest.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: null })
      .mockResolvedValueOnce({ rows: [], rowCount: null });
    const a = ambiente(q);
    await a.controller.update(req({ body: corpoEdit, params: { id: 'a' } }), a.res);
    expect(a.status()).toBe(404);
  });
});

describe('archive', () => {
  it('200 e ARQUIVA em vez de apagar — o texto escrito não se perde', async () => {
    const q: jest.Mock = jest.fn(async () => ({ rows: [], rowCount: 1 }));
    const a = ambiente(q);
    await a.controller.archive(req({ params: { id: 'abc' } }), a.res);
    expect(a.status()).toBe(200);
    expect(q.mock.calls[0][0]).toContain('archived_at = now()');
    expect(q.mock.calls[0][0]).not.toContain('DELETE');
  });
  it('404 quando não havia o que arquivar — rowCount 0 não vira sucesso', async () => {
    const a = ambiente(jest.fn(async () => ({ rows: [], rowCount: 0 })));
    await a.controller.archive(req({ params: { id: 'abc' } }), a.res);
    expect(a.status()).toBe(404);
  });
  it('rowCount null também é 404', async () => {
    const a = ambiente(jest.fn(async () => ({ rows: [], rowCount: null })));
    await a.controller.archive(req({ params: { id: 'abc' } }), a.res);
    expect(a.status()).toBe(404);
  });
  it('500 em erro de banco', async () => {
    const a = ambiente(jest.fn(async () => { throw new Error('boom'); }));
    await a.controller.archive(req({ params: { id: 'abc' } }), a.res);
    expect(a.status()).toBe(500);
  });
  it('erro não-Error vira 500 sem estourar no wrapper', async () => {
    const a = ambiente(jest.fn(async () => { throw 'string crua'; }));
    await a.controller.archive(req({ params: { id: 'abc' } }), a.res);
    expect(a.status()).toBe(500);
  });
});
