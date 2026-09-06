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
  body: 'Hola {{worker_name}}, te esperamos.', category: 'UTILITY', language: 'es-AR',
  version: 1, created_by: 'uid-a', updated_by: 'uid-a',
  created_at: '2026-08-31T12:00:00Z', updated_at: '2026-08-31T12:00:00Z',
  content_sid: null, submitted_at: null, submitted_by: null, submission_error: null,
  meta_approval_status: null, meta_approval_reason: null,
  meta_approval_detail: null, meta_approval_checked_at: null,
  ...over,
});

const corpoOk = {
  slug: 'bienvenida', name: 'Bienvenida',
  body: 'Hola {{worker_name}}, te esperamos.', category: 'UTILITY', language: 'es-AR',
};

function ambiente(queryImpl: jest.Mock, submitter?: { execute: jest.Mock }) {
  const db = { query: queryImpl } as never;
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as unknown as Response;
  return {
    db, res,
    controller: new TemplateDraftsController(db, submitter as never),
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
      // `submit` delega ao caso de uso; o controller em si não fala com a rede.
      const e = ambiente(jest.fn(), { execute: jest.fn(async () => ({ tipo: 'nao_encontrado' })) });
      await e.controller.submit(req({ body: { confirmado: true }, params: { id: 'x' } }), e.res);
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
  it('rascunho JÁ SUBMETIDO vem com status=submitted e o SID — a tela muda o que permite', async () => {
    const a = ambiente(jest.fn(async () => ({
      rows: [linha({ content_sid: 'HXja', submitted_at: '2026-08-31T20:00:00Z', submitted_by: 'uid-b' })],
      rowCount: 1,
    })));
    await a.controller.list(req(), a.res);
    expect(a.body().data.drafts[0]).toMatchObject({
      status: 'submitted', contentSid: 'HXja', submittedBy: 'uid-b',
    });
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
    // ⚠️ Índice 6, não 5: o `base_name` (migration 302) entrou como 2º
    // parâmetro do INSERT e empurrou todos os seguintes. Asserção posicional
    // paga esse preço — em troca, ela pega uma troca de ordem que um
    // `objectContaining` deixaria passar.
    expect(q.mock.calls[1][1][6]).toBe('uid-a');
  });
  it('sem usuário na request a autoria fica null, não quebra', async () => {
    const q = jest.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [linha()], rowCount: 1 });
    const a = ambiente(q);
    await a.controller.create({ body: corpoOk, params: {} } as unknown as Request, a.res);
    expect(q.mock.calls[1][1][6]).toBeNull();
  });
  /**
   * 🔒 A BASE VEM DO SLUG FINAL, não do que veio no payload. Assim
   * `slug === slugComPrefixo(base_name, language)` vale sempre, inclusive
   * quando a normalização mudou o que a pessoa digitou. Se a base guardasse o
   * texto cru, "Bienvenida Nueva" viraria slug `ar_bienvenida_nueva` e base
   * `Bienvenida Nueva` — e o par nunca fecharia com a versão portuguesa.
   */
  it('grava base_name derivada do slug final, sem o prefixo do idioma', async () => {
    const q = jest.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [linha()], rowCount: 1 });
    const a = ambiente(q);
    await a.controller.create(req({ body: { ...corpoOk, slug: 'Bienvenida Nueva' } }), a.res);
    expect(q.mock.calls[1][1][0]).toBe('ar_bienvenida_nueva');
    expect(q.mock.calls[1][1][1]).toBe('bienvenida_nueva');
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
    await a.controller.create(req({ body: { ...corpoOk, body: 'Hola {{1}} amigo' } }), a.res);
    expect(a.status()).toBe(422);
    expect(a.body().problemas.map((p: { regra: string }) => p.regra)).toContain('placeholder_posicional');
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
      .mockResolvedValueOnce({ rows: [{ version: 7, content_sid: null }], rowCount: 1 });
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
    await a.controller.update(req({ body: { ...corpoEdit, body: 'x {{worker_name}}{{case_number}} y' }, params: { id: 'a' } }), a.res);
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

describe('submit — o ato irreversível', () => {
  const sub = (r: unknown) => ({ execute: jest.fn(async () => r) });
  const pedido = (over: Record<string, unknown> = {}) =>
    req({ body: { confirmado: true, ...over }, params: { id: 'id-1' } });

  it('🔒 SEM `confirmado: true` é 400 — e o caso de uso NEM É CHAMADO', async () => {
    const caso = sub({ contentSid: 'HXa' });
    const a = ambiente(jest.fn(), caso);
    await a.controller.submit(req({ body: {}, params: { id: 'id-1' } }), a.res);
    expect(a.status()).toBe(400);
    expect(a.body().error).toBe('confirmacao_obrigatoria');
    expect(caso.execute).not.toHaveBeenCalled();
  });

  it('`confirmado` que não é o booleano true não vale — nem "true", nem 1', async () => {
    for (const v of ['true', 1, 'sim', {}]) {
      const caso = sub({ contentSid: 'HXa' });
      const a = ambiente(jest.fn(), caso);
      await a.controller.submit(pedido({ confirmado: v }), a.res);
      expect(a.status()).toBe(400);
      expect(caso.execute).not.toHaveBeenCalled();
    }
  });

  it('body ausente é 400, não estouro', async () => {
    const caso = sub({ contentSid: 'HXa' });
    const a = ambiente(jest.fn(), caso);
    await a.controller.submit({ params: { id: 'x' } } as unknown as Request, a.res);
    expect(a.status()).toBe(400);
  });

  it('200 com o resultado quando dá certo, e passa o ator', async () => {
    const caso = sub({ contentSid: 'HXnovo', slug: 'ar_x', bodyTwilio: 'a {{1}}', variaveis: ['worker_name'] });
    const a = ambiente(jest.fn(), caso);
    await a.controller.submit(pedido(), a.res);
    expect(a.status()).toBe(200);
    expect(a.body().data.submission.contentSid).toBe('HXnovo');
    expect(caso.execute).toHaveBeenCalledWith('id-1', 'uid-a');
  });

  it('404 quando o rascunho não existe', async () => {
    const a = ambiente(jest.fn(), sub({ tipo: 'nao_encontrado' }));
    await a.controller.submit(pedido(), a.res);
    expect(a.status()).toBe(404);
  });

  it('409 quando já foi submetido — e diz QUAL Content já existe', async () => {
    const a = ambiente(jest.fn(), sub({ tipo: 'ja_submetido', contentSid: 'HXja' }));
    await a.controller.submit(pedido(), a.res);
    expect(a.status()).toBe(409);
    expect(a.body()).toMatchObject({ error: 'ja_submetido', contentSid: 'HXja' });
  });

  it('422 quando o texto não passa nas regras', async () => {
    const a = ambiente(jest.fn(), sub({ tipo: 'regras', problemas: [{ campo: 'body', regra: 'placeholder_posicional' }] }));
    await a.controller.submit(pedido(), a.res);
    expect(a.status()).toBe(422);
    expect(a.body().problemas).toHaveLength(1);
  });

  it('🔒 503 — e NÃO 500 — quando a submissão está desligada, dizendo o motivo', async () => {
    for (const motivo of ['flag_desligada', 'sem_credencial']) {
      const a = ambiente(jest.fn(), sub({ tipo: 'indisponivel', motivo }));
      await a.controller.submit(pedido(), a.res);
      expect(a.status()).toBe(503);
      expect(a.body()).toMatchObject({ error: 'submissao_indisponivel', motivo });
    }
  });

  it('502 quando a Twilio falha, com a mensagem dela', async () => {
    const a = ambiente(jest.fn(), sub({ tipo: 'twilio', mensagem: '400 nome em uso' }));
    await a.controller.submit(pedido(), a.res);
    expect(a.status()).toBe(502);
    expect(a.body().mensagem).toBe('400 nome em uso');
  });

  it('500 quando o próprio caso de uso estoura', async () => {
    const a = ambiente(jest.fn(), { execute: jest.fn(async () => { throw new Error('boom'); }) });
    await a.controller.submit(pedido(), a.res);
    expect(a.status()).toBe(500);
  });

  it('erro não-Error também vira 500', async () => {
    const a = ambiente(jest.fn(), { execute: jest.fn(async () => { throw 'string crua'; }) });
    await a.controller.submit(pedido(), a.res);
    expect(a.status()).toBe(500);
  });
});

describe('update recusa editar o que já foi submetido', () => {
  it('409 com "use duplicar" — o texto que foi à Meta não se reescreve por baixo', async () => {
    const q = jest.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ version: 1, content_sid: 'HXja' }], rowCount: 1 });
    const a = ambiente(q);
    await a.controller.update(req({ body: { ...corpoOk, version: 1 }, params: { id: 'id-1' } }), a.res);
    expect(a.status()).toBe(409);
    expect(a.body().error).toBe('ja_submetido_use_duplicar');
  });
});

describe('duplicate — duplicar e corrigir', () => {
  it('201 com slug sufixado, e o clone nasce SEM content_sid', async () => {
    const q = jest.fn()
      .mockResolvedValueOnce({ rows: [linha({ content_sid: 'HXja' })], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [linha({ slug: 'ar_bienvenida_v2' })], rowCount: 1 });
    const a = ambiente(q);
    await a.controller.duplicate(req({ params: { id: 'id-1' } }), a.res);
    expect(a.status()).toBe(201);
    expect(q.mock.calls[2][1][0]).toBe('ar_bienvenida_v2');
    expect(a.body().data.draft.contentSid).toBeNull();
    expect(a.body().data.draft.status).toBe('draft');
  });

  it('pula os sufixos já ocupados em vez de bater no índice único', async () => {
    const q = jest.fn()
      .mockResolvedValueOnce({ rows: [linha()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ slug: 'ar_bienvenida_v2' }, { slug: 'ar_bienvenida_v3' }], rowCount: 2 })
      .mockResolvedValueOnce({ rows: [linha({ slug: 'ar_bienvenida_v4' })], rowCount: 1 });
    const a = ambiente(q);
    await a.controller.duplicate(req({ params: { id: 'id-1' } }), a.res);
    expect(q.mock.calls[2][1][0]).toBe('ar_bienvenida_v4');
  });

  it('404 quando a origem não existe', async () => {
    const a = ambiente(jest.fn(async () => ({ rows: [], rowCount: 0 })));
    await a.controller.duplicate(req({ params: { id: 'x' } }), a.res);
    expect(a.status()).toBe(404);
  });

  it('rowCount null na origem também é 404', async () => {
    const a = ambiente(jest.fn(async () => ({ rows: [], rowCount: null })));
    await a.controller.duplicate(req({ params: { id: 'x' } }), a.res);
    expect(a.status()).toBe(404);
  });

  it('500 em erro de banco', async () => {
    const a = ambiente(jest.fn(async () => { throw new Error('boom'); }));
    await a.controller.duplicate(req({ params: { id: 'x' } }), a.res);
    expect(a.status()).toBe(500);
  });

  it('erro não-Error vira 500', async () => {
    const a = ambiente(jest.fn(async () => { throw 'string crua'; }));
    await a.controller.duplicate(req({ params: { id: 'x' } }), a.res);
    expect(a.status()).toBe(500);
  });
});

describe('🔒 o estado da META chega na lista — o bug de 01/09', () => {
  it('enviado e SEM resposta da Meta ainda é "submitted"', async () => {
    const a = ambiente(jest.fn(async () => ({
      rows: [linha({ content_sid: 'HXa', submitted_at: '2026-09-01T02:00:00Z' })], rowCount: 1,
    })));
    await a.controller.list(req(), a.res);
    expect(a.body().data.drafts[0]).toMatchObject({ status: 'submitted', metaStatus: null });
  });

  it('🔒 enviado e APROVADO vira "decided" — antes ficava "submitted" PARA SEMPRE', async () => {
    const a = ambiente(jest.fn(async () => ({
      rows: [linha({
        content_sid: 'HXa', submitted_at: '2026-09-01T02:00:00Z',
        meta_approval_status: 'APPROVED', meta_approval_checked_at: '2026-09-01T03:00:00Z',
      })], rowCount: 1,
    })));
    await a.controller.list(req(), a.res);
    expect(a.body().data.drafts[0]).toMatchObject({
      status: 'decided', metaStatus: 'APPROVED', metaReason: null,
    });
  });

  it('recusado traz o motivo e a explicação em prosa', async () => {
    const a = ambiente(jest.fn(async () => ({
      rows: [linha({
        content_sid: 'HXa', submitted_at: '2026-09-01T02:00:00Z',
        meta_approval_status: 'REJECTED', meta_approval_reason: 'INCORRECT_CATEGORY',
        meta_approval_detail: 'A categoria não bate com o conteúdo.',
      })], rowCount: 1,
    })));
    await a.controller.list(req(), a.res);
    expect(a.body().data.drafts[0]).toMatchObject({
      status: 'decided', metaStatus: 'REJECTED', metaReason: 'INCORRECT_CATEGORY',
      metaDetail: 'A categoria não bate com o conteúdo.',
    });
  });

  it('🔒 a listagem faz LEFT JOIN por content_sid — sem isso o estado nunca chega', async () => {
    const q: jest.Mock = jest.fn(async () => ({ rows: [], rowCount: 0 }));
    const a = ambiente(q);
    await a.controller.list(req(), a.res);
    const sql = q.mock.calls[0][0] as string;
    expect(sql).toContain('LEFT JOIN message_templates');
    expect(sql).toContain('meta_approval_status');
    expect(sql).toMatch(/UPPER\(t\.content_sid\)\s*=\s*UPPER\(d\.content_sid\)/);
  });

  it('rascunho nunca enviado continua "draft", mesmo com a junção', async () => {
    const a = ambiente(jest.fn(async () => ({ rows: [linha()], rowCount: 1 })));
    await a.controller.list(req(), a.res);
    expect(a.body().data.drafts[0]).toMatchObject({ status: 'draft', metaStatus: null });
  });
});
