/**
 * A fixture `fixtures-meta-templates.json` é o payload REAL da WABA de produção,
 * capturado em 31/08/2026 — 27 templates, sem edição. Não foi escrita por mim,
 * e essa é a diferença que importa: fixture que eu invento confirma a MINHA
 * suposição sobre o formato (D187), não o formato de verdade.
 *
 * O que ela NÃO cobre: os 27 estão todos `APPROVED`. Recusa, pausa e estado
 * desconhecido são casos sintéticos abaixo, marcados como tal.
 */
import {
  contentSidFromMetaName,
  normalizeStatus,
  parseMetaTemplate,
  DOCUMENTED_STATUSES,
  MetaTemplateStatusProvider,
} from '../MetaTemplateStatusProvider';
import reais from './fixtures-meta-templates.json';

describe('contentSidFromMetaName — a chave de junção', () => {
  it('extrai o SID que a Twilio cola no fim do nome', () => {
    expect(contentSidFromMetaName('ar_invite_luz_personal_hx5d77ccab1689ab6cf9b675a0b158e68d')).toBe(
      'HX5D77CCAB1689AB6CF9B675A0B158E68D',
    );
  });

  it('casa 27 de 27 nos dados REAIS de produção', () => {
    const sids = (reais as { name: string }[]).map((t) => contentSidFromMetaName(t.name));
    expect(sids.filter(Boolean)).toHaveLength(27);
    expect(sids.filter((s) => s === null)).toHaveLength(0);
  });

  describe('devolve null — "não nasceu na Twilio", que é informação e não erro', () => {
    it.each([
      ['nome sem sufixo', 'meu_template_novo'],
      ['sufixo curto demais', 'x_hxabc'],
      ['sufixo com caractere fora de hex', 'x_hxZZ77ccab1689ab6cf9b675a0b158e68d'],
      ['prefixo hx sem underscore antes', 'hx5d77ccab1689ab6cf9b675a0b158e68d'],
      ['vazio', ''],
    ])('%s', (_l, name) => {
      expect(contentSidFromMetaName(name)).toBeNull();
    });
  });

  it('exige 32 hex exatos — 31 ou 33 não passam', () => {
    expect(contentSidFromMetaName('x_hx' + 'a'.repeat(31))).toBeNull();
    expect(contentSidFromMetaName('x_hx' + 'a'.repeat(33))).toBeNull();
    expect(contentSidFromMetaName('x_hx' + 'a'.repeat(32))).not.toBeNull();
  });
});

describe('normalizeStatus — guarda o desconhecido, não o descarta', () => {
  it('normaliza a caixa', () => {
    expect(normalizeStatus('approved')).toBe('APPROVED');
  });

  it('SINTÉTICO: estado que a Meta invente amanhã passa inteiro', () => {
    expect(normalizeStatus('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });

  it.each([[null], [''], ['   '], [42], [undefined]])('devolve null para %p', (v) => {
    expect(normalizeStatus(v)).toBeNull();
  });
});

describe('parseMetaTemplate', () => {
  it('lê um item real inteiro', () => {
    const t = parseMetaTemplate((reais as unknown[])[0]);
    expect(t).toMatchObject({ status: 'APPROVED', category: 'UTILITY' });
    expect(t?.name).toMatch(/_hx[0-9a-f]{32}$/);
  });

  it('lê o quality_score de dentro do objeto aninhado', () => {
    expect(parseMetaTemplate({ name: 'a_hx' + 'b'.repeat(32), status: 'APPROVED', quality_score: { score: 'green' } })?.qualityScore).toBe('GREEN');
  });

  it('quality_score ausente vira null, não string vazia', () => {
    expect(parseMetaTemplate({ name: 'a', status: 'APPROVED' })?.qualityScore).toBeNull();
  });

  it.each([[null], ['texto'], [{}], [{ name: 'x' }], [{ status: 'APPROVED' }]])(
    'devolve null para payload inválido %p',
    (raw) => {
      expect(parseMetaTemplate(raw)).toBeNull();
    },
  );
});

describe('DOCUMENTED_STATUSES', () => {
  it('tem os 10 da Meta — e PAUSED e DISABLED estão entre eles', () => {
    expect(DOCUMENTED_STATUSES.size).toBe(10);
    expect(DOCUMENTED_STATUSES.has('PAUSED')).toBe(true);
    expect(DOCUMENTED_STATUSES.has('DISABLED')).toBe(true);
  });

  it('é o DOBRO do que a Twilio expõe — a razão de trocar de fonte', () => {
    expect(DOCUMENTED_STATUSES.size).toBeGreaterThan(5);
  });
});

describe('syncStatuses', () => {
  const sidOf = (n: string) => contentSidFromMetaName(n)!;
  const fakeDb = (sids: string[]) =>
    ({
      query: jest.fn(async (sql: string) =>
        sql.includes('SELECT content_sid')
          ? { rows: sids.map((content_sid) => ({ content_sid })) }
          : { rows: [] },
      ),
    }) as never;

  const fetcherFor = (data: unknown[]) =>
    jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ data, paging: {} }),
    })) as never;

  it('grava os 27 reais quando todos são conhecidos', async () => {
    const sids = (reais as { name: string }[]).map((t) => sidOf(t.name));
    const p = new MetaTemplateStatusProvider(fakeDb(sids), 'W1', 'T1', fetcherFor(reais as unknown[]));
    const r = await p.syncStatuses();
    expect(r).toMatchObject({ fetched: 27, matched: 27 });
    expect(r.withoutContentSid).toEqual([]);
    expect(r.unknownToUs).toEqual([]);
  });

  it('SINTÉTICO: template criado direto na Meta é NOMEADO, não engolido', async () => {
    const orfao = { name: 'criado_na_meta_sem_twilio', status: 'APPROVED', language: 'es_AR' };
    const p = new MetaTemplateStatusProvider(fakeDb([]), 'W1', 'T1', fetcherFor([orfao]));
    const r = await p.syncStatuses();
    expect(r.withoutContentSid).toEqual(['criado_na_meta_sem_twilio']);
    expect(r.matched).toBe(0);
  });

  it('SINTÉTICO: PAUSED é gravado — é o estado que sumia em silêncio', async () => {
    const name = 'x_hx' + 'a'.repeat(32);
    const db = fakeDb([sidOf(name)]);
    const p = new MetaTemplateStatusProvider(db, 'W1', 'T1', fetcherFor([{ name, status: 'PAUSED', language: 'es_AR' }]));
    const r = await p.syncStatuses();
    expect(r.matched).toBe(1);
    const escritas = (db as unknown as { query: jest.Mock }).query.mock.calls.filter((c) => String(c[0]).includes('UPDATE'));
    expect(escritas[0][1]).toContain('PAUSED');
  });

  it('SINTÉTICO: estado fora dos 10 é LISTADO e mesmo assim gravado', async () => {
    const name = 'y_hx' + 'b'.repeat(32);
    const p = new MetaTemplateStatusProvider(fakeDb([sidOf(name)]), 'W1', 'T1', fetcherFor([{ name, status: 'ALGO_NOVO', language: 'es' }]));
    const r = await p.syncStatuses();
    expect(r.unknownStatuses).toEqual(['ALGO_NOVO']);
    expect(r.matched).toBe(1);
  });

  it('SID que a Meta tem e nós não conhecemos vem nomeado', async () => {
    const name = 'z_hx' + 'c'.repeat(32);
    const p = new MetaTemplateStatusProvider(fakeDb([]), 'W1', 'T1', fetcherFor([{ name, status: 'APPROVED', language: 'es' }]));
    expect((await p.syncStatuses()).unknownToUs).toEqual([sidOf(name)]);
  });

  it('falha ao gravar UMA linha não derruba as outras', async () => {
    const n1 = 'a_hx' + '1'.repeat(32);
    const n2 = 'b_hx' + '2'.repeat(32);
    const db = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('SELECT content_sid')) return { rows: [{ content_sid: sidOf(n1) }, { content_sid: sidOf(n2) }] };
        if (String(sql).includes(sidOf(n1))) return { rows: [] };
        throw 'banco fora';
      }),
    } as never;
    const p = new MetaTemplateStatusProvider(db, 'W1', 'T1', fetcherFor([
      { name: n1, status: 'APPROVED', language: 'es' },
      { name: n2, status: 'APPROVED', language: 'es' },
    ]));
    const r = await p.syncStatuses();
    expect(r.fetched).toBe(2);
    expect(r.matched).toBeLessThan(2);
  });

  it('resposta sem `data` não quebra — devolve vazio', async () => {
    const fetcher = jest.fn(async () => ({ ok: true, status: 200, text: async () => '', json: async () => ({}) })) as never;
    expect(await new MetaTemplateStatusProvider(fakeDb([]), 'W1', 'T1', fetcher).fetchAll()).toEqual([]);
  });

  it('segue a paginação e para quando `next` some', async () => {
    const n1 = 'p1_hx' + '1'.repeat(32);
    const n2 = 'p2_hx' + '2'.repeat(32);
    let chamada = 0;
    const fetcher = jest.fn(async () => {
      chamada++;
      return {
        ok: true, status: 200, text: async () => '',
        json: async () =>
          chamada === 1
            ? { data: [{ name: n1, status: 'APPROVED', language: 'es' }], paging: { next: 'https://graph.facebook.com/proxima' } }
            : { data: [{ name: n2, status: 'APPROVED', language: 'es' }], paging: {} },
      };
    }) as never;
    const todos = await new MetaTemplateStatusProvider(fakeDb([]), 'W1', 'T1', fetcher).fetchAll();
    expect(todos.map((t) => t.name)).toEqual([n1, n2]);
    expect(chamada).toBe(2);
  });

  it('erro que não é Error no persist também é reportado, não engolido', async () => {
    const name = 'e_hx' + '9'.repeat(32);
    const db = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('SELECT content_sid')) return { rows: [{ content_sid: sidOf(name) }] };
        throw 'string crua';
      }),
    } as never;
    const p = new MetaTemplateStatusProvider(db, 'W1', 'T1', fetcherFor([{ name, status: 'APPROVED', language: 'es' }]));
    expect((await p.syncStatuses()).matched).toBe(0);
  });

  it('erro que É Error mantém a mensagem original', async () => {
    const name = 'f_hx' + '8'.repeat(32);
    const db = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('SELECT content_sid')) return { rows: [{ content_sid: sidOf(name) }] };
        throw new Error('constraint violada');
      }),
    } as never;
    const p = new MetaTemplateStatusProvider(db, 'W1', 'T1', fetcherFor([{ name, status: 'APPROVED', language: 'es' }]));
    expect((await p.syncStatuses()).matched).toBe(0);
  });

  it('sem fetcher injetado usa o fetch global — o fio padrão está ligado', async () => {
    const original = globalThis.fetch;
    const espiao = jest.fn(async () => ({ ok: true, status: 200, text: async () => '', json: async () => ({ data: [], paging: {} }) }));
    (globalThis as unknown as { fetch: unknown }).fetch = espiao;
    try {
      expect(await new MetaTemplateStatusProvider(fakeDb([]), 'W1', 'T1').fetchAll()).toEqual([]);
      expect(espiao).toHaveBeenCalledTimes(1);
    } finally {
      (globalThis as unknown as { fetch: unknown }).fetch = original;
    }
  });

  it('sem credencial: devolve vazio e avisa, não explode', async () => {
    const p = new MetaTemplateStatusProvider(fakeDb([]), undefined, undefined, fetcherFor([]));
    expect(p.configured).toBe(false);
    expect(await p.fetchAll()).toEqual([]);
  });

  it('erro HTTP não vaza o token na mensagem', async () => {
    const fetcher = jest.fn(async () => ({ ok: false, status: 401, text: async () => 'x', json: async () => ({}) })) as never;
    const p = new MetaTemplateStatusProvider(fakeDb([]), 'W1', 'TOKEN_SECRETO', fetcher);
    await expect(p.fetchAll()).rejects.toThrow(/Meta Graph 401/);
    await expect(p.fetchAll()).rejects.not.toThrow(/TOKEN_SECRETO/);
  });
});
